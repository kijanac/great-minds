import { browser } from "$app/env";
import { newUuid, replyRequest } from "@great-minds/client";
import type {
  CreateReplyRequest,
  Passage,
  SessionActivity,
  SessionDetail,
  SessionId,
  SessionOrigin,
  SessionResponse,
  Uuid,
} from "@great-minds/domain";

import { createReply, retryReply, stopReply, streamReply } from "#lib/api/replies.ts";
import { applyReplySnapshot } from "#lib/reply-turn.ts";
import type { Exchange, Phase, SelectionInfo, StopStatus, ThreadLike } from "#lib/types.ts";
import { genId, isAbortError } from "#lib/utils.ts";

export interface ConversationOptions {
  saved?: SessionDetail | SessionResponse;
  origin?: SessionOrigin | null;
  initialQuery?: string;
  onCreated?: (sessionId: SessionId) => void;
}

export class Conversation implements ThreadLike {
  activity = $state<SessionActivity | null>(null);
  connectionError = $state<string | null>(null);
  exchanges = $state<Exchange[]>([]);
  sessionId = $state<SessionId | null>(null);
  #failedSubmission = $state.raw<CreateReplyRequest | null>(null);
  #stopAction = $state.raw<{ readonly status: StopStatus } | null>(null);
  readonly id: string;
  readonly origin: SessionOrigin | null;
  readonly originTitle: string | null;
  readonly passage: Passage | null;
  readonly createdAt: Date | null;
  readonly unavailable: string | null;

  #title: string | null;
  #onCreated: ((sessionId: SessionId) => void) | undefined;
  #idempotencyKey: Uuid | null = null;
  #retry: { previousReplyId: Uuid; replyId: Uuid } | null = null;
  #abortController: AbortController | null = null;
  #destroyed = false;

  constructor(options: ConversationOptions = {}) {
    const { saved } = options;
    this.sessionId = saved?.session.id ?? null;
    this.id = this.sessionId === null ? genId("thread") : `thread:${this.sessionId}`;
    this.origin = saved ? saved.session.origin : (options.origin ?? null);
    this.originTitle = saved?.session.origin_title ?? null;
    this.#title = saved?.session.query ?? null;
    this.createdAt = saved?.session.created_at ?? null;
    this.unavailable = saved?.availability === "unavailable" ? saved.detail : null;
    this.passage = this.origin?.passage ?? null;
    this.#onCreated = options.onCreated;
    const content = saved?.availability === "available" ? saved : null;
    this.exchanges = (content?.exchanges ?? []).map((exchange) => ({
      id: exchange.exchange_id,
      query: exchange.query,
      sources: exchange.sources,
      answer: exchange.answer,
      citations: exchange.citations,
      btws: [],
      replyId: exchange.reply_id,
      status: exchange.status,
      version: exchange.version,
      error: exchange.error,
    }));
    this.activity = content?.activity ?? null;
    for (const child of saved !== undefined && "threads" in saved ? saved.threads : []) {
      const origin = child.session.origin;
      if (origin?.kind !== "answer") continue;
      this.exchanges
        .find((exchange) => exchange.id === origin.exchange_id)
        ?.btws.push(new Conversation({ saved: child }));
    }

    if (browser) {
      queueMicrotask(() => {
        if (this.#destroyed) return;
        if (content === null && this.unavailable === null && options.initialQuery) {
          void this.#runExchange(options.initialQuery, false);
        } else {
          this.#resumePendingReplies();
        }
      });
    }
  }

  get title(): string {
    return this.#title ?? this.exchanges[0]?.query ?? "";
  }

  get draft(): boolean {
    return this.sessionId === null;
  }

  get phase(): Phase {
    const pending = this.activity
      ? this.exchanges.find((exchange) => exchange.replyId === this.activity?.reply_id)
      : this.exchanges.find((exchange) => exchange.status === "running");

    if (this.activity?.status === "settling" || (this.activity && pending?.status !== "running"))
      return "finalizing";
    if (pending?.status === "running") return pending.answer.length > 0 ? "streaming" : "searching";
    return this.exchanges.length > 0 ? "done" : "idle";
  }

  get canAsk(): boolean {
    return this.unavailable === null && (this.phase === "idle" || this.phase === "done");
  }

  get stopStatus(): StopStatus | null {
    return this.#stopAction?.status ?? null;
  }

  get canStop(): boolean {
    return (
      this.activity !== null &&
      this.activity.status !== "settling" &&
      this.stopStatus !== "requested"
    );
  }

  get submissionFailed(): boolean {
    return this.#failedSubmission !== null;
  }

  get retryTarget() {
    const exchange = this.exchanges.at(-1);
    return exchange?.status === "failed" && exchange.replyId !== undefined && this.phase === "done"
      ? { exchange, replyId: exchange.replyId }
      : null;
  }

  destroy = (): void => {
    this.#destroyed = true;
    this.#retry = null;
    this.#stopAction = null;
    this.#abortController?.abort();
    for (const exchange of this.exchanges) {
      for (const btw of exchange.btws) btw.destroy();
    }
  };

  #updateExchange = (id: Uuid, patch: Partial<Exchange>): void => {
    this.exchanges = this.exchanges.map((exchange) =>
      exchange.id === id ? { ...exchange, ...patch } : exchange,
    );
  };

  #tailExchange = async (exchangeId: Uuid, replyId: Uuid, signal: AbortSignal): Promise<void> => {
    try {
      for await (const snapshot of streamReply(replyId, signal)) {
        if (signal.aborted || snapshot.session_id !== this.sessionId) return;
        const current = this.exchanges.find((exchange) => exchange.id === exchangeId);
        if (current?.replyId !== replyId) return;
        const updated = applyReplySnapshot(current, snapshot);
        if (updated === null) continue;
        this.#updateExchange(exchangeId, updated.exchange);
        this.activity = updated.activity;
        if (updated.activity === null || updated.activity.status === "settling")
          this.#stopAction = null;
      }
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return;
      console.error("Failed to resume reply:", error);
    }
    if (!signal.aborted && this.activity?.reply_id === replyId) {
      this.connectionError = "Live updates are unavailable. Reconnect to check this response.";
      if (this.stopStatus === "requested") this.#stopAction = null;
    }
  };

  reconnect = (): void => {
    if (this.#destroyed) return;
    this.#abortController?.abort();
    if (this.stopStatus === "requested") this.#stopAction = null;
    this.connectionError = null;
    this.#resumePendingReplies();
  };

  #resumePendingReplies = (): void => {
    const pendingExchange = this.exchanges.find(
      (exchange) => exchange.replyId === this.activity?.reply_id,
    );
    if (pendingExchange?.replyId) {
      const controller = new AbortController();
      this.#abortController = controller;
      void this.#tailExchange(pendingExchange.id, pendingExchange.replyId, controller.signal);
    }
  };

  #makeRequest = (question: string, inline: boolean): CreateReplyRequest => {
    const origin = this.origin;
    return replyRequest({
      question,
      exchangeId: newUuid(),
      inline,
      originScope: origin?.kind === "document" ? origin.origin_scope : "vault",
      ...(this.sessionId === null && origin?.kind === "document" && origin.passage === null
        ? { originPath: origin.doc_path }
        : {}),
      conversation:
        this.sessionId !== null
          ? { kind: "existing", id: this.sessionId }
          : {
              kind: "new",
              idempotencyKey: (this.#idempotencyKey ??= newUuid()),
              ...(origin ? { origin } : {}),
            },
    });
  };

  #runExchange = async (question: string, inline: boolean): Promise<boolean> => {
    const payload =
      this.#failedSubmission?.question === question
        ? this.#failedSubmission
        : this.#makeRequest(question, inline);
    const exchangeId = payload.exchange_id;
    this.#failedSubmission = null;
    this.connectionError = null;
    this.exchanges = [
      ...this.exchanges,
      {
        id: exchangeId,
        query: payload.question,
        sources: [],
        answer: "",
        citations: [],
        btws: [],
        status: "running",
        version: null,
      },
    ];

    this.#abortController?.abort();
    const controller = new AbortController();
    this.#abortController = controller;

    let created;
    try {
      created = await createReply(payload, controller.signal);
    } catch (error) {
      this.exchanges = this.exchanges.filter((exchange) => exchange.id !== exchangeId);
      if (isAbortError(error) || controller.signal.aborted) return false;
      console.error("Query failed:", error);
      this.#failedSubmission = payload;
      return false;
    }

    if (controller.signal.aborted) return false;
    this.#updateExchange(exchangeId, { replyId: created.reply_id });
    this.activity = { reply_id: created.reply_id, status: "running" };
    if (this.sessionId === null) {
      this.sessionId = created.session_id;
      this.#onCreated?.(created.session_id);
    }
    void this.#tailExchange(exchangeId, created.reply_id, controller.signal);
    return true;
  };

  ask = (question: string, inline = false): Promise<boolean> => {
    if (this.#destroyed || !this.canAsk || !question.trim()) return Promise.resolve(false);
    return this.#runExchange(question, inline);
  };

  retry = (exchangeId: Uuid): void => {
    if (this.#destroyed) return;
    const target = this.retryTarget;
    if (target?.exchange.id !== exchangeId) return;
    const { exchange: previous, replyId } = target;
    const attempt =
      this.#retry?.previousReplyId === replyId
        ? this.#retry
        : { previousReplyId: replyId, replyId: newUuid() };
    this.#retry = attempt;
    this.#updateExchange(exchangeId, {
      sources: [],
      answer: "",
      citations: [],
      status: "running",
      version: null,
      error: null,
    });
    this.connectionError = null;
    this.#abortController?.abort();
    const controller = new AbortController();
    this.#abortController = controller;

    void (async () => {
      try {
        const created = await retryReply(
          attempt.previousReplyId,
          attempt.replyId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        this.#retry = null;
        this.#updateExchange(exchangeId, { replyId: created.reply_id });
        this.activity = { reply_id: created.reply_id, status: "running" };
        await this.#tailExchange(exchangeId, created.reply_id, controller.signal);
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return;
        console.error("Reply retry failed:", error);
        this.exchanges = this.exchanges.map((exchange) =>
          exchange.id === exchangeId ? previous : exchange,
        );
      }
    })();
  };

  stop = async (): Promise<void> => {
    const replyId = this.activity?.reply_id;
    if (this.#destroyed || replyId === undefined || !this.canStop) return;
    const action = { status: "requested" } as const;
    this.#stopAction = action;
    try {
      await stopReply(replyId, this.#abortController?.signal);
    } catch (error) {
      if (isAbortError(error) || this.#stopAction !== action) return;
      this.#stopAction = { status: "failed" };
    }
  };

  clearSubmissionFailure = (): void => {
    this.#failedSubmission = null;
  };

  startBtw = (info: SelectionInfo): void => {
    if (!this.sessionId) return;
    const exchange = this.exchanges.find((item) => item.id === info.exchangeId);

    if (
      !exchange ||
      (exchange.status !== "completed" && exchange.status !== "stopped") ||
      this.activity?.reply_id === exchange.replyId
    )
      return;

    exchange.btws.push(
      new Conversation({
        origin: {
          kind: "answer",
          session_id: this.sessionId,
          exchange_id: info.exchangeId,
          passage: info.passage,
        },
      }),
    );
  };

  dismissBtw = (btwId: string): void => {
    this.exchanges = this.exchanges.map((exchange) => {
      const target = exchange.btws.find((btw) => btw.id === btwId);
      if (!target?.draft || target.exchanges.length > 0) return exchange;
      target.destroy();
      return {
        ...exchange,
        btws: exchange.btws.filter((btw) => btw.id !== btwId),
      };
    });
  };
}
