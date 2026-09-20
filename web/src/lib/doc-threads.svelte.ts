import type { SessionId, Uuid } from "@great-minds/domain";

import { listSessionsByOrigin, type OriginScope } from "$lib/api/sessions";
import { Btw } from "$lib/btw.svelte";
import { passageMark, revealPassage } from "$lib/passage-navigation";
import type { SelectionInfo } from "$lib/types";
import { isAbortError } from "$lib/utils";

export class DocThreads {
  threads = $state<Btw[]>([]);
  loading = $state(true);
  error = $state<string | null>(null);
  jumpable = $state<Set<string>>(new Set());
  expanded = $state<Set<string>>(new Set());

  #controller = new AbortController();

  constructor(
    private readonly originPath: string,
    private readonly originScope: OriginScope,
    private readonly onOpenSession: (sessionId: SessionId) => void,
  ) {
    void this.#load();
  }

  destroy = (): void => {
    this.#controller.abort();
    for (const thread of this.threads) thread.destroy();
  };

  #load = async (): Promise<void> => {
    try {
      const details = await listSessionsByOrigin(this.originPath, this.#controller.signal);
      if (this.#controller.signal.aborted) return;
      this.threads = details.flatMap((detail) =>
        detail.session.origin?.kind === "document"
          ? [new Btw(detail.session.origin, this.onOpenSession, detail)]
          : [],
      );
      this.refreshJumpable();
    } catch (error) {
      if (isAbortError(error) || this.#controller.signal.aborted) return;
      console.error("Failed to load doc threads:", error);
      this.error = "failed to load notes";
    } finally {
      this.loading = false;
    }
  };

  /** Re-check which anchors resolve to a rendered mark (or, for in-flight
   * drafts, a rendered block) in the document. Persisted threads whose quote
   * could not be located render a pure gutter dot instead and lose the jump
   * affordance. */
  refreshJumpable = (): void => {
    const next = new Set<string>();
    for (const thread of this.threads) {
      if (thread.anchor.blockOffset < 0) continue;
      const mark = passageMark(thread.id);
      if (mark !== null) {
        next.add(thread.id);
        continue;
      }
      if (!thread.draft) continue;
      const block = window.document.querySelector<HTMLElement>(
        `[data-block-offset="${CSS.escape(String(thread.anchor.blockOffset))}"]`,
      );
      if (block !== null) next.add(thread.id);
    }
    this.jumpable = next;
  };

  #findThread = (threadId: string): Btw | undefined =>
    this.threads.find((thread) => thread.id === threadId);

  startThread = (info: SelectionInfo): void => {
    const thread = new Btw(
      {
        kind: "document",
        doc_path: this.originPath,
        origin_scope: this.originScope,
        anchor: info.quote,
        paragraph: info.context,
        paragraph_index: info.blockOffset,
      },
      this.onOpenSession,
    );
    this.threads = [...this.threads, thread];
    this.expanded = new Set([...this.expanded, thread.id]);
    this.refreshJumpable();
  };

  replyThread = (threadId: string, userText: string): void => {
    this.#findThread(threadId)?.reply(userText);
  };

  retryThread = (threadId: string, turnId: Uuid): void => {
    this.#findThread(threadId)?.retry(turnId);
  };

  dismissEmpty = (threadId: string): void => {
    const target = this.#findThread(threadId);
    if (!target?.draft || target.exchanges.length > 0) return;
    target.destroy();
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
    void this.#findThread(threadId)?.openSession();
  };

  /** Expand a thread and scroll its anchor mark into view (chip "jump").
   * Drafts have no mark yet — fall back to scrolling their block (the
   * painted highlight). */
  jumpTo = (threadId: string): void => {
    const target = this.#findThread(threadId);
    if (!target) return;
    this.expanded = new Set([...this.expanded, threadId]);
    requestAnimationFrame(() => {
      const mark = passageMark(threadId);
      if (mark) {
        revealPassage(mark);
        return;
      }
      const block = window.document.querySelector<HTMLElement>(
        `[data-block-offset="${target.anchor.blockOffset}"]`,
      );
      if (block) revealPassage(block);
    });
  };
}
