import { browser } from "$app/env";
import type {
  Passage,
  SessionActivity,
  SessionDetail,
  SessionId,
  SessionOrigin,
  SessionResponse,
  Uuid,
} from "@great-minds/domain";

import { createReply, retryReply, stopReply, type CreateReplyPayload } from "#lib/api/replies.ts";
import { newUuid, replyRequest } from "@great-minds/client";
import { LIVE_UPDATES_UNAVAILABLE, tailReply } from "#lib/reply-tail.ts";
import type { Exchange, Phase, SelectionInfo, ThreadLike } from "#lib/types.ts";
import { genId, isAbortError } from "#lib/utils.ts";

type ReplyAttempt = {
  exchangeId: Uuid;
  payload: CreateReplyPayload;
};

type SubmissionState = { status: "ready" } | { status: "failed"; attempt: ReplyAttempt };

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
  submission = $state<SubmissionState>({ status: "ready" });
  stopping = $state(false);
  stopFailed = $state(false);
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

  get canStop(): boolean {
    return this.activity !== null && this.activity.status !== "settling" && !this.stopping;
  }

  destroy = (): void => {
    this.#destroyed = true;
    this.#retry = null;
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

  #tailExchange = async (
    exchangeId: Uuid,
    replyId: Uuid,
    controller: AbortController,
  ): Promise<void> => {
    const outcome = await tailReply(replyId, controller.signal, {
      conversationId: () => this.sessionId,
      turn: () => this.exchanges.find((exchange) => exchange.id === exchangeId),
      apply: (updated, activity) => {
        this.#updateExchange(exchangeId, updated);
        this.activity = activity;
        if (activity === null || activity.status === "settling") {
          this.stopping = false;
          this.stopFailed = false;
        }
      },
    });
    if (outcome === "ended" && this.activity?.reply_id === replyId) {
      this.connectionError = LIVE_UPDATES_UNAVAILABLE;
      this.stopping = false;
    }
  };

  reconnect = (): void => {
    if (this.#destroyed) return;
    this.#abortController?.abort();
    this.stopping = false;
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
      void this.#tailExchange(pendingExchange.id, pendingExchange.replyId, controller);
    }
  };

  #makeAttempt = (question: string, inline: boolean): ReplyAttempt => {
    const exchangeId = newUuid();
    this.#idempotencyKey ??= newUuid();
    const origin = this.origin;

    const payload: CreateReplyPayload = replyRequest({
      question,
      exchangeId,
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
              idempotencyKey: this.#idempotencyKey,
              ...(origin ? { origin } : {}),
            },
    });
    return { exchangeId, payload };
  };

  #runExchange = async (question: string, inline: boolean): Promise<boolean> => {
    this.stopFailed = false;
    const attempt =
      this.submission.status === "failed" && this.submission.attempt.payload.question === question
        ? this.submission.attempt
        : this.#makeAttempt(question, inline);
    this.submission = { status: "ready" };
    this.connectionError = null;
    this.exchanges = [
      ...this.exchanges,
      {
        id: attempt.exchangeId,
        query: attempt.payload.question,
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
      created = await createReply(attempt.payload, controller.signal);
    } catch (error) {
      this.exchanges = this.exchanges.filter((exchange) => exchange.id !== attempt.exchangeId);
      if (isAbortError(error) || controller.signal.aborted) return false;
      console.error("Query failed:", error);
      this.submission = { status: "failed", attempt };
      return false;
    }

    if (controller.signal.aborted) return false;
    this.#updateExchange(attempt.exchangeId, { replyId: created.reply_id });
    this.activity = { reply_id: created.reply_id, status: "running" };
    if (this.sessionId === null) {
      this.sessionId = created.session_id;
      this.#onCreated?.(created.session_id);
    }
    void this.#tailExchange(attempt.exchangeId, created.reply_id, controller);
    return true;
  };

  ask = (question: string, inline = false): Promise<boolean> => {
    if (this.#destroyed || !this.canAsk || !question.trim()) return Promise.resolve(false);
    return this.#runExchange(question, inline);
  };

  retry = (exchangeId: Uuid): void => {
    if (this.#destroyed || this.phase !== "done") return;
    const index = this.exchanges.findIndex((exchange) => exchange.id === exchangeId);
    const previous = this.exchanges[index];
    if (
      previous === undefined ||
      index !== this.exchanges.length - 1 ||
      previous.status !== "failed" ||
      previous.replyId === undefined
    ) {
      return;
    }

    const attempt =
      this.#retry?.previousReplyId === previous.replyId
        ? this.#retry
        : { previousReplyId: previous.replyId, replyId: newUuid() };
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
    this.stopFailed = false;
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
        await this.#tailExchange(exchangeId, created.reply_id, controller);
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
    if (replyId === undefined || !this.canStop) return;
    this.stopping = true;
    this.stopFailed = false;
    try {
      await stopReply(replyId, this.#abortController?.signal);
    } catch (error) {
      if (isAbortError(error) || this.#destroyed || this.activity?.reply_id !== replyId) return;
      this.stopping = false;
      this.stopFailed = true;
    }
  };

  clearSubmissionFailure = (): void => {
    this.submission = { status: "ready" };
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
