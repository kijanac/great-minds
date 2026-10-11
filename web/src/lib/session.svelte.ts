import { browser } from "$app/environment";
import type {
  SessionActivity,
  SessionId,
  SessionOrigin,
  SessionResponse,
  Uuid,
} from "@great-minds/domain";

import {
  createReply,
  retryReply,
  stopReply,
  streamReply,
  type CreateReplyPayload,
} from "$lib/api/replies";
import { Btw } from "$lib/btw.svelte";
import type { Exchange, Phase, SelectionInfo } from "$lib/types";
import { newUuid } from "$lib/ids";
import { applyReplySnapshot, replyActivity } from "$lib/reply-turn";
import { replayExchanges } from "$lib/session-events";
import { isAbortError } from "$lib/utils";

type MainReplyAttempt = {
  exchangeId: Uuid;
  payload: CreateReplyPayload;
};

type SubmissionState = { status: "ready" } | { status: "failed"; attempt: MainReplyAttempt };

export interface SessionOptions {
  saved?: SessionResponse;
  originPath?: string;
  initialQuery?: string;
  onSessionCreated?: (sessionId: SessionId) => void;
  onOpenSession?: (sessionId: SessionId) => void;
}

export class Session {
  activity = $state<SessionActivity | null>(null);
  connectionError = $state<string | null>(null);
  thread = $state<Exchange[]>([]);
  sessionId = $state<SessionId | null>(null);
  chips = $state<string[]>([]);
  followUpDraft = $state("");
  submission = $state<SubmissionState>({ status: "ready" });
  stopping = $state(false);
  stopFailed = $state(false);
  popover = $state<SelectionInfo | null>(null);
  readonly origin: SessionOrigin | null;
  readonly originTitle: string | null;

  #onSessionCreated: ((sessionId: SessionId) => void) | undefined;
  #onOpenSession: ((sessionId: SessionId) => void) | undefined;
  #idempotencyKey: Uuid | null = null;
  #abortController: AbortController | null = null;
  #destroyed = false;

  constructor(options: SessionOptions = {}) {
    this.thread = replayExchanges(options.saved?.events ?? []);
    this.activity = options.saved?.activity ?? null;
    this.sessionId = options.saved?.id ?? null;
    this.origin = options.saved
      ? (options.saved.events.find((event) => event.type === "meta")?.origin ?? null)
      : options.originPath
        ? {
            kind: "document",
            doc_path: options.originPath,
            origin_scope: "vault",
            anchor: null,
            paragraph: null,
            paragraph_index: null,
          }
        : null;
    this.originTitle = options.saved?.origin_title ?? null;
    this.#onSessionCreated = options.onSessionCreated;
    this.#onOpenSession = options.onOpenSession;
    for (const detail of options.saved?.threads ?? []) {
      const origin = detail.session.origin;
      if (origin?.kind !== "answer") continue;
      this.thread
        .find((exchange) => exchange.id === origin.exchange_id)
        ?.btws.push(new Btw(origin, this.#onOpenSession, detail));
    }

    if (browser) {
      queueMicrotask(() => {
        if (this.#destroyed) return;
        if (!options.saved && options.initialQuery) {
          void this.#runExchange(options.initialQuery);
        } else {
          this.#resumePendingReplies();
        }
      });
    }
  }

  get phase(): Phase {
    const pending = this.activity
      ? this.thread.find((exchange) => exchange.replyId === this.activity?.reply_id)
      : this.thread.find((exchange) => exchange.status === "running");
    if (this.activity?.status === "settling" || (this.activity && pending?.status !== "running"))
      return "finalizing";
    if (pending?.status === "running") return pending.answer.length > 0 ? "streaming" : "searching";
    return this.thread.length > 0 ? "done" : "idle";
  }

  destroy = (): void => {
    this.#destroyed = true;
    this.#abortController?.abort();
    for (const exchange of this.thread) {
      for (const btw of exchange.btws) btw.destroy();
    }
  };

  #updateExchange = (id: Uuid, patch: Partial<Exchange>): void => {
    this.thread = this.thread.map((exchange) =>
      exchange.id === id ? { ...exchange, ...patch } : exchange,
    );
  };

  #tailExchange = async (
    exchangeId: Uuid,
    replyId: Uuid,
    controller: AbortController,
  ): Promise<void> => {
    try {
      for await (const snapshot of streamReply(replyId, controller.signal)) {
        if (controller.signal.aborted || snapshot.session_id !== this.sessionId) return;
        const current = this.thread.find((exchange) => exchange.id === exchangeId);
        if (current?.replyId !== replyId) return;
        const updated = applyReplySnapshot(current, snapshot, true);
        if (updated === null) continue;
        this.#updateExchange(exchangeId, updated);
        this.activity = replyActivity(snapshot, updated);
        if (this.activity === null || this.activity.status === "settling") {
          this.stopping = false;
          this.stopFailed = false;
        }
      }
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return;
      console.error("Failed to resume reply:", error);
    }
    if (!controller.signal.aborted && this.activity?.reply_id === replyId) {
      this.connectionError = "Live updates are unavailable. Reconnect to check this response.";
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
    const pendingExchange = this.thread.find(
      (exchange) => exchange.replyId === this.activity?.reply_id,
    );
    if (pendingExchange?.replyId) {
      const controller = new AbortController();
      this.#abortController = controller;
      void this.#tailExchange(pendingExchange.id, pendingExchange.replyId, controller);
    }
  };

  #makeMainReplyAttempt = (question: string): MainReplyAttempt => {
    const exchangeId = newUuid();
    this.#idempotencyKey ??= newUuid();

    const payload: CreateReplyPayload = {
      reply_id: newUuid(),
      exchange_id: exchangeId,
      question,
      ...(this.sessionId === null && this.origin?.kind === "document"
        ? { origin_path: this.origin.doc_path }
        : {}),
      origin_scope: "vault",
      session:
        this.sessionId !== null
          ? { kind: "existing", id: this.sessionId }
          : {
              kind: "new",
              conversation_kind: "session",
              idempotency_key: this.#idempotencyKey,
              origin_scope: "vault",
              ...(this.origin ? { origin: this.origin } : {}),
            },
    };
    return { exchangeId, payload };
  };

  #runExchange = async (question: string): Promise<boolean> => {
    this.stopFailed = false;
    const attempt =
      this.submission.status === "failed" && this.submission.attempt.payload.question === question
        ? this.submission.attempt
        : this.#makeMainReplyAttempt(question);
    this.submission = { status: "ready" };
    this.connectionError = null;
    this.thread = [
      ...this.thread,
      {
        id: attempt.exchangeId,
        query: attempt.payload.question,
        thinking: [],
        answer: "",
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
      const remaining = this.thread.filter((exchange) => exchange.id !== attempt.exchangeId);
      this.thread = remaining;
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
      this.#onSessionCreated?.(created.session_id);
    }
    void this.#tailExchange(attempt.exchangeId, created.reply_id, controller);
    return true;
  };

  submitQuery = (question: string): void => {
    if (this.phase !== "idle" && this.phase !== "done") return;
    void this.#runExchange(question);
  };

  retryExchange = (exchangeId: Uuid): void => {
    if (this.phase !== "done") return;
    const index = this.thread.findIndex((exchange) => exchange.id === exchangeId);
    const previous = this.thread[index];
    if (
      previous === undefined ||
      index !== this.thread.length - 1 ||
      previous.status !== "failed" ||
      previous.replyId === undefined
    ) {
      return;
    }

    this.#updateExchange(exchangeId, {
      thinking: [],
      answer: "",
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
        const created = await retryReply(previous.replyId!, newUuid(), controller.signal);
        this.#updateExchange(exchangeId, { replyId: created.reply_id });
        this.activity = { reply_id: created.reply_id, status: "running" };
        await this.#tailExchange(exchangeId, created.reply_id, controller);
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return;
        console.error("Reply retry failed:", error);
        this.thread = this.thread.map((exchange) =>
          exchange.id === exchangeId ? previous : exchange,
        );
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

  get canStop(): boolean {
    return this.activity !== null && this.activity.status !== "settling" && !this.stopping;
  }

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
    if (!this.sessionId) return;
    const exchange = this.thread.find((item) => item.id === info.exchangeId);
    if (
      !exchange ||
      (exchange.status !== "completed" && exchange.status !== "stopped") ||
      this.activity?.reply_id === exchange.replyId
    )
      return;
    exchange.btws.push(
      new Btw(
        {
          kind: "answer",
          session_id: this.sessionId,
          exchange_id: info.exchangeId,
          anchor: info.quote,
          paragraph_index: info.blockOffset,
          paragraph: info.context,
        },
        this.#onOpenSession,
      ),
    );
    this.popover = null;
    window.getSelection()?.removeAllRanges();
  };

  #findBtw = (btwId: string): Btw | undefined =>
    this.thread.flatMap((exchange) => exchange.btws).find((btw) => btw.id === btwId);

  replyBtw = (btwId: string, userText: string): void => {
    this.#findBtw(btwId)?.reply(userText);
  };

  retryBtw = (btwId: string, turnId: Uuid): void => {
    this.#findBtw(btwId)?.retry(turnId);
  };

  dismissBtw = (btwId: string): void => {
    this.thread = this.thread.map((exchange) => {
      const target = exchange.btws.find((btw) => btw.id === btwId);
      if (!target?.draft || target.exchanges.length > 0) return exchange;
      target.destroy();
      return {
        ...exchange,
        btws: exchange.btws.filter((btw) => btw.id !== btwId),
      };
    });
  };

  openBtwSession = (btwId: string): void => {
    void this.#findBtw(btwId)?.openSession();
  };

  handleSelection = (info: SelectionInfo | null): void => {
    this.popover = info;
  };

  clearPopover = (): void => {
    this.popover = null;
  };
}
