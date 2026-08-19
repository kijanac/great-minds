import { createReply, streamReply } from "$lib/api/replies";
import { listSessionsByOrigin, type OriginScope, type SessionEvent } from "$lib/api/sessions";
import type { DocThread, Exchange, SelectionInfo } from "$lib/types";
import { buildBtwHistory, genId, isAbortError } from "$lib/utils";

/**
 * Persistent annotation threads anchored to a document. Loads every session
 * the caller owns for this doc (anchored note threads plus doc-initiated
 * conversations) via by-origin, and owns the local draft flow: a highlight
 * creates a draft thread locally (no server call) that becomes a real session
 * the moment its first reply is created.
 */
export class DocThreads {
  threads = $state<DocThread[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  // Thread ids whose anchor block is present in the rendered document body.
  // Only these offer a jump affordance from the header panel; the body guard
  // skips inline rendering for unresolvable anchors, so jumping would be a
  // no-op. Refreshed from the DOM whenever the body (re)mounts.
  jumpable = $state<Set<string>>(new Set());
  // Thread ids currently expanded inline in the reader. Owned here so both the
  // doc-header chip (jump to mark) and the body rendering share one signal.
  expanded = $state<Set<string>>(new Set());

  #controllers = new Set<AbortController>();
  #loaded = false;

  constructor(
    private readonly originPath: string,
    private readonly originScope: OriginScope,
    private readonly onOpenSession: (sessionId: string) => void,
  ) {
    void this.load();
  }

  destroy = (): void => {
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    this.threads = [];
    this.expanded = new Set();
    this.error = null;
    this.#loaded = false;
  };

  load = async (): Promise<void> => {
    if (this.#loaded) return;
    this.#loaded = true;
    this.loading = true;
    const controller = new AbortController();
    this.#controllers.add(controller);
    try {
      const details = await listSessionsByOrigin(this.originPath, controller.signal);
      this.threads = details.map((detail) => {
        const origin = detail.session.origin;
        const anchored = origin?.anchor !== null && origin?.anchor !== undefined;
        return {
          id: `thread:${detail.session.id}`,
          sessionId: detail.session.id,
          draft: false,
          anchored,
          anchor: {
            blockOffset: origin?.paragraph_index ?? -1,
            quote: origin?.anchor ?? "",
            context: origin?.paragraph ?? "",
          },
          exchanges: detail.events
            .filter(
              (event): event is Extract<SessionEvent, { type: "exchange" }> =>
                event.type === "exchange",
            )
            .map((event) => ({
              id: event.exId,
              query: event.query,
              thinking: event.thinking,
              answer: event.answer,
              btws: [],
              replyId: event.reply_id,
              streaming: false,
            })),
          createdAt: detail.session.created_at,
        };
      });
      this.error = null;
      this.refreshJumpable();
    } catch (error) {
      if (isAbortError(error)) return;
      console.error("Failed to load doc threads:", error);
      this.error = "failed to load notes";
    } finally {
      this.loading = false;
      this.#controllers.delete(controller);
    }
  };

  /** Re-check which anchors resolve to a rendered block in the document. */
  refreshJumpable = (): void => {
    const next = new Set<string>();
    for (const thread of this.threads) {
      if (thread.anchor.blockOffset < 0) continue;
      const block = window.document.querySelector<HTMLElement>(
        `[data-block-offset="${CSS.escape(String(thread.anchor.blockOffset))}"]`,
      );
      if (block !== null) next.add(thread.id);
    }
    this.jumpable = next;
  };

  #findThread = (threadId: string): DocThread | undefined =>
    this.threads.find((thread) => thread.id === threadId);

  /** Highlight → local draft. No server call until the first question lands. */
  startThread = (info: SelectionInfo): void => {
    const id = genId("note");
    this.threads = [
      ...this.threads,
      {
        id,
        sessionId: null,
        draft: true,
        anchored: true,
        anchor: {
          blockOffset: info.blockOffset,
          quote: info.quote,
          context: info.context,
        },
        exchanges: [],
        createdAt: null,
      },
    ];
    this.expanded = new Set([...this.expanded, id]);
    this.refreshJumpable();
  };

  replyThread = (threadId: string, userText: string): void => {
    const target = this.#findThread(threadId);
    if (!target) return;
    const anchor = target.anchor;
    const priorExchanges = target.exchanges;
    // A draft whose first create failed (no session yet) retries as a fresh
    // first turn; anything with a session follows up on it.
    const isFirst = priorExchanges.length === 0 || target.sessionId === null;
    const turnId = genId("ex");

    const patchThread = (patch: Partial<DocThread>): void => {
      this.threads = this.threads.map((thread) =>
        thread.id === threadId ? { ...thread, ...patch } : thread,
      );
    };
    const patchExchanges = (mutate: (exchanges: Exchange[]) => Exchange[]): void =>
      patchThread({
        exchanges: mutate(this.threads.find((thread) => thread.id === threadId)?.exchanges ?? []),
      });
    const patchTurn = (patch: Partial<Exchange>): void =>
      patchExchanges((exchanges) =>
        exchanges.map((exchange) =>
          exchange.id === turnId ? { ...exchange, ...patch } : exchange,
        ),
      );

    patchExchanges((exchanges) => [
      ...exchanges,
      {
        id: turnId,
        query: userText,
        thinking: [],
        answer: "",
        btws: [],
        streaming: true,
      },
    ]);

    const controller = new AbortController();
    this.#controllers.add(controller);

    // The draft survives until the reply settles: once the server owns the
    // session the thread is persistent, even if the stream then fails.
    const settleDraft = (): void => {
      if (this.#findThread(threadId)?.sessionId) {
        patchThread({ draft: false });
      }
    };

    void (async () => {
      try {
        const created = isFirst
          ? await createReply(
              {
                kind: "exchange",
                exchange_id: turnId,
                create: {
                  idempotency_key: crypto.randomUUID(),
                  origin_scope: this.originScope,
                  origin: {
                    doc_path: this.originPath,
                    origin_scope: this.originScope,
                    anchor: anchor.quote,
                    paragraph: anchor.context,
                    paragraph_index: anchor.blockOffset,
                  },
                },
                // The server composes the passage/highlight prompt; the
                // session stores this clean text.
                question: userText,
                history: [],
                mode: "btw",
              },
              controller.signal,
            )
          : await createReply(
              {
                kind: "exchange",
                exchange_id: turnId,
                session_id: target.sessionId!,
                question: userText,
                // First history turn is composed via buildBtwQuery semantics
                // from the thread's origin; later turns are raw.
                history: buildBtwHistory(priorExchanges, anchor),
                mode: "btw",
              },
              controller.signal,
            );
        patchTurn({ replyId: created.reply_id });
        if (target.sessionId === null && created.session_id !== null) {
          patchThread({ sessionId: created.session_id });
        }
        for await (const snapshot of streamReply(created.reply_id, controller.signal)) {
          patchTurn({
            thinking: snapshot.sources.length > 0 ? [{ sources: snapshot.sources }] : [],
            answer: snapshot.answer,
            streaming: snapshot.status === "running",
            error: snapshot.error,
          });
        }
        settleDraft();
      } catch (error) {
        if (isAbortError(error)) return;
        console.error("Doc thread reply failed:", error);
        patchTurn({ streaming: false });
        settleDraft();
      } finally {
        this.#controllers.delete(controller);
      }
    })();
  };

  dismissEmpty = (threadId: string): void => {
    const target = this.#findThread(threadId);
    if (!target?.draft || target.exchanges.length > 0) return;
    this.threads = this.threads.filter((thread) => thread.id !== threadId);
    const next = new Set(this.expanded);
    next.delete(threadId);
    this.expanded = next;
  };

  toggleExpanded = (threadId: string): void => {
    const next = new Set(this.expanded);
    if (next.has(threadId)) next.delete(threadId);
    else next.add(threadId);
    this.expanded = next;
  };

  openSession = (threadId: string): void => {
    const target = this.#findThread(threadId);
    if (target?.sessionId) this.onOpenSession(target.sessionId);
  };

  /** Expand a thread and scroll its anchor block into view (chip "jump"). */
  jumpTo = (threadId: string): void => {
    const target = this.#findThread(threadId);
    if (!target) return;
    this.expanded = new Set([...this.expanded, threadId]);
    requestAnimationFrame(() => {
      const block = window.document.querySelector<HTMLElement>(
        `[data-block-offset="${target.anchor.blockOffset}"]`,
      );
      block?.scrollIntoView({ block: "start" });
    });
  };
}
