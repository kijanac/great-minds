import { browser } from "$app/environment";

import {
  createReply,
  retryReply,
  streamReply,
  type CreateReplyPayload,
  type ReplySnapshot,
} from "$lib/api/replies";
import type { BtwThread, Exchange, HistoryMessage, Phase, SelectionInfo } from "$lib/types";
import { buildBtwHistory, buildBtwQuery, genId, isAbortError } from "$lib/utils";

function threadToHistory(thread: Exchange[]): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  for (const exchange of thread) {
    history.push({ role: "user", content: exchange.query });
    history.push({ role: "assistant", content: exchange.answer });
  }
  return history;
}

type MainReplyPayload = Extract<CreateReplyPayload, { kind: "exchange" }>;

type MainReplyAttempt = {
  exchangeId: string;
  payload: MainReplyPayload;
};

type SubmissionState = { status: "ready" } | { status: "failed"; attempt: MainReplyAttempt };

export interface SessionOptions {
  initialExchanges?: Exchange[];
  sessionId?: string;
  originPath?: string;
  initialQuery?: string;
  onSessionCreated?: (sessionId: string) => void;
}

export class Session {
  phase = $state<Phase>("idle");
  thread = $state<Exchange[]>([]);
  sessionId = $state<string | null>(null);
  chips = $state<string[]>([]);
  followUpDraft = $state("");
  submission = $state<SubmissionState>({ status: "ready" });
  popover = $state<SelectionInfo | null>(null);

  #originPath: string | undefined;
  #onSessionCreated: ((sessionId: string) => void) | undefined;
  #idempotencyKey: string | null = null;
  #abortController: AbortController | null = null;
  #btwControllers = new Set<AbortController>();
  #destroyed = false;

  constructor(options: SessionOptions = {}) {
    this.phase = options.initialExchanges?.length ? "done" : "idle";
    this.thread = options.initialExchanges ?? [];
    this.sessionId = options.sessionId ?? null;
    this.#originPath = options.originPath;
    this.#onSessionCreated = options.onSessionCreated;

    if (browser) {
      queueMicrotask(() => {
        if (this.#destroyed) return;
        if (options.initialQuery) {
          void this.#runExchange(options.initialQuery);
        } else {
          this.#resumePendingReplies();
        }
      });
    }
  }

  destroy = (): void => {
    this.#destroyed = true;
    this.#abortController?.abort();
    for (const controller of this.#btwControllers) controller.abort();
    this.#btwControllers.clear();
  };

  #updateExchange = (id: string, patch: Partial<Exchange>): void => {
    this.thread = this.thread.map((exchange) =>
      exchange.id === id ? { ...exchange, ...patch } : exchange,
    );
  };

  #snapshotThinking = (snapshot: ReplySnapshot, alwaysBlock: boolean) =>
    snapshot.sources.length > 0 || alwaysBlock ? [{ sources: snapshot.sources }] : [];

  #tailExchange = async (
    exchangeId: string,
    replyId: string,
    controller: AbortController,
  ): Promise<void> => {
    try {
      for await (const snapshot of streamReply(replyId, controller.signal)) {
        this.phase =
          snapshot.status === "running"
            ? snapshot.answer.length > 0
              ? "streaming"
              : "searching"
            : "done";
        this.#updateExchange(exchangeId, {
          answer: snapshot.answer,
          thinking: this.#snapshotThinking(snapshot, true),
          streaming: snapshot.status === "running",
          error: snapshot.error,
          replyId,
        });
      }
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return;
      console.error("Failed to resume reply:", error);
      this.#updateExchange(exchangeId, { streaming: false });
      this.phase = "done";
    }
  };

  #updateBtwReply = (replyId: string, patch: Partial<Exchange>): void => {
    this.thread = this.thread.map((exchange) => ({
      ...exchange,
      btws: exchange.btws.map((btw) => ({
        ...btw,
        exchanges: btw.exchanges.map((turn) =>
          turn.replyId === replyId ? { ...turn, ...patch } : turn,
        ),
      })),
    }));
  };

  #updateBtwTurn = (btwId: string, turnId: string, patch: Partial<Exchange>): void => {
    this.thread = this.thread.map((exchange) => ({
      ...exchange,
      btws: exchange.btws.map((btw) =>
        btw.id !== btwId
          ? btw
          : {
              ...btw,
              exchanges: btw.exchanges.map((turn) =>
                turn.id === turnId ? { ...turn, ...patch } : turn,
              ),
            },
      ),
    }));
  };

  #tailBtwReply = async (replyId: string, controller: AbortController): Promise<void> => {
    try {
      for await (const snapshot of streamReply(replyId, controller.signal)) {
        this.#updateBtwReply(replyId, {
          answer: snapshot.answer,
          thinking: this.#snapshotThinking(snapshot, false),
          streaming: snapshot.status === "running",
          error: snapshot.error,
        });
      }
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return;
      console.error("Failed to resume BTW reply:", error);
      this.#updateBtwReply(replyId, { streaming: false });
    } finally {
      this.#btwControllers.delete(controller);
    }
  };

  #resumePendingReplies = (): void => {
    const pendingExchange = this.thread.find(
      (exchange) => exchange.replyId !== undefined && exchange.answer.length === 0,
    );
    if (pendingExchange?.replyId) {
      this.phase = "searching";
      const controller = new AbortController();
      this.#abortController = controller;
      void this.#tailExchange(pendingExchange.id, pendingExchange.replyId, controller);
    }

    for (const btw of this.thread.flatMap((exchange) => exchange.btws)) {
      const turn = btw.exchanges.at(-1);
      if (turn?.replyId === undefined || turn.answer.length > 0) continue;
      const controller = new AbortController();
      this.#btwControllers.add(controller);
      void this.#tailBtwReply(turn.replyId, controller);
    }
  };

  #makeMainReplyAttempt = (question: string): MainReplyAttempt => {
    const exchangeId = genId("ex");
    const replyId = crypto.randomUUID();
    const firstExchange = this.sessionId === null;
    const originForQuery = firstExchange ? this.#originPath : undefined;
    const history = threadToHistory(this.thread);
    const existingSessionId = this.sessionId;
    this.#idempotencyKey ??= crypto.randomUUID();

    const payload: MainReplyPayload = existingSessionId
      ? {
          reply_id: replyId,
          kind: "exchange",
          exchange_id: exchangeId,
          session_id: existingSessionId,
          question,
          origin_path: originForQuery,
          history,
          mode: "query",
        }
      : {
          reply_id: replyId,
          kind: "exchange",
          exchange_id: exchangeId,
          create: {
            idempotency_key: this.#idempotencyKey,
            ...(this.#originPath
              ? {
                  origin: {
                    doc_path: this.#originPath,
                    origin_scope: "vault" as const,
                    anchor: null,
                    paragraph: null,
                    paragraph_index: null,
                  },
                }
              : {}),
          },
          question,
          origin_path: originForQuery,
          history,
          mode: "query",
        };
    return { exchangeId, payload };
  };

  #runExchange = async (question: string): Promise<boolean> => {
    const attempt =
      this.submission.status === "failed" && this.submission.attempt.payload.question === question
        ? this.submission.attempt
        : this.#makeMainReplyAttempt(question);
    this.submission = { status: "ready" };
    this.phase = "searching";
    this.thread = [
      ...this.thread,
      {
        id: attempt.exchangeId,
        query: attempt.payload.question,
        thinking: [],
        answer: "",
        btws: [],
        streaming: true,
      },
    ];

    this.#abortController?.abort();
    const controller = new AbortController();
    this.#abortController = controller;

    let created;
    try {
      created = await createReply(attempt.payload, controller.signal);
    } catch (error) {
      const remaining = this.thread.filter((exchange) => exchange.id !== attempt.exchangeId);
      this.thread = remaining;
      this.phase = remaining.length > 0 ? "done" : "idle";
      if (isAbortError(error) || controller.signal.aborted) return false;
      console.error("Query failed:", error);
      this.submission = { status: "failed", attempt };
      return false;
    }

    this.#updateExchange(attempt.exchangeId, { replyId: created.reply_id });
    if (this.sessionId === null && created.session_id !== null) {
      this.sessionId = created.session_id;
      this.#onSessionCreated?.(created.session_id);
    }
    void this.#tailExchange(attempt.exchangeId, created.reply_id, controller);
    return true;
  };

  submitQuery = (question: string): void => {
    if (this.phase !== "idle" && this.phase !== "done") return;
    void this.#runExchange(question);
  };

  retryExchange = (exchangeId: string): void => {
    if (this.phase !== "done") return;
    const index = this.thread.findIndex((exchange) => exchange.id === exchangeId);
    const previous = this.thread[index];
    if (
      previous === undefined ||
      index !== this.thread.length - 1 ||
      previous.streaming ||
      previous.replyId === undefined
    ) {
      return;
    }

    this.phase = "searching";
    this.#updateExchange(exchangeId, {
      thinking: [],
      answer: "",
      streaming: true,
      error: null,
    });
    this.#abortController?.abort();
    const controller = new AbortController();
    this.#abortController = controller;

    void (async () => {
      try {
        const created = await retryReply(previous.replyId!, crypto.randomUUID(), controller.signal);
        this.#updateExchange(exchangeId, { replyId: created.reply_id });
        await this.#tailExchange(exchangeId, created.reply_id, controller);
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return;
        console.error("Reply retry failed:", error);
        this.thread = this.thread.map((exchange) =>
          exchange.id === exchangeId ? previous : exchange,
        );
        this.phase = "done";
      }
    })();
  };

  submitFollowUp = (): void => {
    if (this.phase !== "done") return;
    const draft = this.followUpDraft;
    const selectedChips = [...this.chips];
    const parts = [...selectedChips.map((chip) => `re: "${chip}"`), draft.trim()].filter(Boolean);
    const question = parts.join(" — ");
    if (!question.trim()) return;

    void (async () => {
      const accepted = await this.#runExchange(question);
      if (!accepted) return;
      if (this.followUpDraft === draft) {
        this.followUpDraft = "";
      }
      if (selectedChips.every((chip, index) => this.chips[index] === chip)) {
        this.chips = this.chips.slice(selectedChips.length);
      }
    })();
  };

  clearSubmissionFailure = (): void => {
    this.submission = { status: "ready" };
  };

  addChip = (text: string): void => {
    this.clearSubmissionFailure();
    this.chips = [...this.chips, text];
    this.popover = null;
    window.getSelection()?.removeAllRanges();
  };

  removeChip = (index: number): void => {
    this.clearSubmissionFailure();
    this.chips = this.chips.filter((_, itemIndex) => itemIndex !== index);
  };

  startBtw = (info: SelectionInfo): void => {
    const btw: BtwThread = {
      id: genId("btw"),
      exchangeId: info.exchangeId,
      anchor: {
        blockOffset: info.blockOffset,
        quote: info.quote,
        context: info.context,
      },
      exchanges: [],
    };

    this.thread = this.thread.map((exchange) =>
      exchange.id === info.exchangeId ? { ...exchange, btws: [...exchange.btws, btw] } : exchange,
    );
    this.popover = null;
    window.getSelection()?.removeAllRanges();
  };

  replyBtw = (btwId: string, userText: string): void => {
    const target = this.thread.flatMap((exchange) => exchange.btws).find((btw) => btw.id === btwId);
    const anchor = target?.anchor ?? {
      blockOffset: -1,
      quote: "",
      context: "",
    };
    const priorExchanges = target?.exchanges ?? [];
    const isFirst = priorExchanges.length === 0;
    const ownerExchangeId = target?.exchangeId ?? "";
    const turnId = genId("ex");

    // History must exclude the optimistic turn added below.
    const baseHistory = threadToHistory(this.thread);

    const patchBtwExchanges = (mutate: (exchanges: Exchange[]) => Exchange[]): void => {
      this.thread = this.thread.map((exchange) =>
        exchange.id !== ownerExchangeId
          ? exchange
          : {
              ...exchange,
              btws: exchange.btws.map((btw) =>
                btw.id === btwId ? { ...btw, exchanges: mutate(btw.exchanges) } : btw,
              ),
            },
      );
    };
    const patchTurn = (patch: Partial<Exchange>): void =>
      patchBtwExchanges((exchanges) =>
        exchanges.map((exchange) =>
          exchange.id === turnId ? { ...exchange, ...patch } : exchange,
        ),
      );

    patchBtwExchanges((exchanges) => [
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

    const question = isFirst ? buildBtwQuery(anchor, userText) : userText;
    const history = [...baseHistory, ...buildBtwHistory(priorExchanges, anchor)];
    const controller = new AbortController();
    this.#btwControllers.add(controller);

    void (async () => {
      try {
        if (!this.sessionId) {
          throw new Error("Cannot persist BTW without a session");
        }
        const pendingBtw = {
          quote: anchor.quote,
          blockOffset: anchor.blockOffset,
          context: anchor.context,
          exchangeId: ownerExchangeId,
          exchanges: [...priorExchanges, { query: userText, thinking: [], answer: "" }].map(
            (exchange) => ({
              query: exchange.query,
              thinking: exchange.thinking,
              answer: exchange.answer,
            }),
          ),
        };
        const created = await createReply(
          {
            reply_id: crypto.randomUUID(),
            kind: "btw",
            session_id: this.sessionId,
            btw: pendingBtw,
            question,
            history,
            mode: "btw",
          },
          controller.signal,
        );
        patchTurn({ replyId: created.reply_id });
        await this.#tailBtwReply(created.reply_id, controller);
      } catch (error) {
        if (isAbortError(error)) return;
        console.error("BTW reply failed:", error);
        patchTurn({ streaming: false });
      } finally {
        this.#btwControllers.delete(controller);
      }
    })();
  };

  retryBtw = (btwId: string, turnId: string): void => {
    const btw = this.thread
      .flatMap((exchange) => exchange.btws)
      .find((candidate) => candidate.id === btwId);
    const index = btw?.exchanges.findIndex((turn) => turn.id === turnId) ?? -1;
    const previous = index >= 0 ? btw?.exchanges[index] : undefined;
    if (
      btw === undefined ||
      previous === undefined ||
      index !== btw.exchanges.length - 1 ||
      previous.streaming ||
      previous.replyId === undefined
    ) {
      return;
    }

    this.#updateBtwTurn(btwId, turnId, {
      thinking: [],
      answer: "",
      streaming: true,
      error: null,
    });
    const controller = new AbortController();
    this.#btwControllers.add(controller);

    void (async () => {
      try {
        const created = await retryReply(previous.replyId!, crypto.randomUUID(), controller.signal);
        this.#updateBtwTurn(btwId, turnId, { replyId: created.reply_id });
        await this.#tailBtwReply(created.reply_id, controller);
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return;
        console.error("BTW reply retry failed:", error);
        this.thread = this.thread.map((exchange) => ({
          ...exchange,
          btws: exchange.btws.map((candidate) =>
            candidate.id !== btwId
              ? candidate
              : {
                  ...candidate,
                  exchanges: candidate.exchanges.map((turn) =>
                    turn.id === turnId ? previous : turn,
                  ),
                },
          ),
        }));
      } finally {
        this.#btwControllers.delete(controller);
      }
    })();
  };

  dismissBtw = (btwId: string): void => {
    this.thread = this.thread.map((exchange) => {
      const target = exchange.btws.find((btw) => btw.id === btwId);
      if (!target || target.exchanges.length > 0) return exchange;
      return {
        ...exchange,
        btws: exchange.btws.filter((btw) => btw.id !== btwId),
      };
    });
  };

  handleSelection = (info: SelectionInfo | null): void => {
    this.popover = info;
  };

  clearPopover = (): void => {
    this.popover = null;
  };
}
