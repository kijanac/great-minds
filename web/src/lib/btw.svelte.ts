import { browser } from "$app/environment";
import type {
  OriginSessionDetail,
  SessionActivity,
  SessionId,
  SessionOrigin,
  Uuid,
} from "@great-minds/domain";

import { createReply, retryReply, streamReply, type CreateReplyPayload } from "$lib/api/replies";
import { selectedVault } from "$lib/api/selected-vault";
import { continueAsSession } from "$lib/api/sessions";
import { newUuid } from "$lib/ids";
import { queryClient } from "$lib/query-client";
import { applyReplySnapshot, replyActivity } from "$lib/reply-turn";
import { replayExchanges } from "$lib/session-events";
import type { Exchange, ThreadLike } from "$lib/types";
import { genId, isAbortError } from "$lib/utils";

type BtwSubmission =
  | { kind: "create"; payload: CreateReplyPayload }
  | { kind: "retry"; previousReplyId: Uuid; replyId: Uuid };

export class Btw implements ThreadLike {
  conversation = $state<ThreadLike["conversation"]>(null);
  exchanges = $state<Exchange[]>([]);
  promoting = $state(false);
  error = $state<string | null>(null);
  unavailable = $state<string | null>(null);
  connectionError = $state<string | null>(null);
  activity = $state<SessionActivity | null>(null);

  readonly id: string;
  readonly anchor: ThreadLike["anchor"];
  readonly createdAt: Date | null;

  #controller = new AbortController();
  #streamController: AbortController | null = null;
  #attempt: BtwSubmission | null = null;

  constructor(
    private readonly origin: SessionOrigin,
    private readonly onOpenSession?: (sessionId: SessionId) => void,
    saved?: OriginSessionDetail,
  ) {
    this.id = saved ? `thread:${saved.session.id}` : genId("btw");
    this.anchor = {
      blockOffset: origin.paragraph_index ?? -1,
      quote: origin.anchor ?? "",
      context: origin.paragraph ?? "",
    };
    this.createdAt = saved?.session.created_at ?? null;
    this.conversation = saved?.session ?? null;
    if (saved?.availability === "available") {
      this.exchanges = replayExchanges(saved.events);
      this.activity = saved.activity;
    } else if (saved?.availability === "unavailable") {
      this.unavailable = saved.detail;
    }
    if (browser) {
      queueMicrotask(() => {
        const pending = this.exchanges.find((turn) => turn.replyId === this.activity?.reply_id);
        if (
          !this.#controller.signal.aborted &&
          this.conversation?.kind === "btw" &&
          pending?.replyId
        )
          void this.#tail(pending.id, pending.replyId);
      });
    }
  }

  get draft(): boolean {
    return this.conversation === null;
  }

  get busy(): boolean {
    return (
      this.#controller.signal.aborted ||
      this.promoting ||
      this.unavailable !== null ||
      this.activity !== null ||
      this.exchanges.some((turn) => turn.status === "running")
    );
  }

  get finalizing(): boolean {
    return this.activity?.status === "settling";
  }

  destroy = (): void => {
    this.#controller.abort();
    this.#streamController?.abort();
    this.#attempt = null;
  };

  #patchTurn = (turnId: Uuid, patch: Partial<Exchange>): void => {
    this.exchanges = this.exchanges.map((turn) =>
      turn.id === turnId ? { ...turn, ...patch } : turn,
    );
  };

  #tail = async (turnId: Uuid, replyId: Uuid): Promise<void> => {
    this.#streamController?.abort();
    const controller = new AbortController();
    this.#streamController = controller;
    this.connectionError = null;
    try {
      for await (const snapshot of streamReply(replyId, controller.signal)) {
        if (controller.signal.aborted || snapshot.session_id !== this.conversation?.id) return;
        const current = this.exchanges.find((turn) => turn.id === turnId);
        if (current?.replyId !== replyId) return;
        const updated = applyReplySnapshot(current, snapshot);
        if (updated === null) continue;
        this.#patchTurn(turnId, updated);
        this.activity = replyActivity(snapshot, updated);
      }
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return;
    }
    if (!controller.signal.aborted && this.activity?.reply_id === replyId)
      this.connectionError = "Live updates are unavailable. Reconnect to check this response.";
  };

  #runReply = async (previous: Exchange): Promise<void> => {
    const attempt = this.#attempt;
    if (attempt === null) return;
    this.#patchTurn(previous.id, {
      thinking: [],
      answer: "",
      status: "running",
      version: null,
      error: null,
    });
    try {
      const created = await (attempt.kind === "create"
        ? createReply(attempt.payload, this.#controller.signal)
        : retryReply(attempt.previousReplyId, attempt.replyId, this.#controller.signal));
      if (this.#controller.signal.aborted) return;
      this.conversation ??= { id: created.session_id, kind: "btw", query: previous.query };
      this.#attempt = null;
      this.#patchTurn(previous.id, { replyId: created.reply_id });
      this.activity = { reply_id: created.reply_id, status: "running" };
      await this.#tail(previous.id, created.reply_id);
    } catch (error) {
      if (isAbortError(error) || this.#controller.signal.aborted) return;
      this.#patchTurn(previous.id, {
        ...previous,
        status: "failed",
        error: "Couldn't send this BTW. Try again.",
      });
    }
  };

  reply = (question: string): void => {
    if (this.busy || this.conversation?.kind === "session") return;
    const turn: Exchange = {
      id: newUuid(),
      query: question,
      thinking: [],
      answer: "",
      btws: [],
      status: "running",
      version: null,
    };
    const scope = this.origin.kind === "document" ? this.origin.origin_scope : "vault";
    const payload: CreateReplyPayload = {
      reply_id: newUuid(),
      exchange_id: turn.id,
      question,
      origin_scope: scope,
      session: this.conversation
        ? { kind: "existing", id: this.conversation.id }
        : {
            kind: "new",
            conversation_kind: "btw",
            idempotency_key: this.id,
            origin_scope: scope,
            origin: this.origin,
          },
    };
    this.#attempt = { kind: "create", payload };
    this.exchanges = [...this.exchanges, turn];
    void this.#runReply(turn);
  };

  retry = (turnId: Uuid): void => {
    if (this.#controller.signal.aborted || this.conversation?.kind === "session") return;
    if (this.connectionError) {
      const pending = this.exchanges.find((turn) => turn.replyId === this.activity?.reply_id);
      if (pending?.replyId) void this.#tail(pending.id, pending.replyId);
      return;
    }
    const previous = this.exchanges.at(-1);
    if (this.busy || previous?.id !== turnId || previous.status !== "failed") return;
    if (this.#attempt === null && previous.replyId) {
      this.#attempt = { kind: "retry", previousReplyId: previous.replyId, replyId: newUuid() };
    }
    void this.#runReply(previous);
  };

  openSession = async (): Promise<void> => {
    const conversation = this.conversation;
    if (!conversation || this.#controller.signal.aborted || this.promoting) return;
    if (conversation.kind === "session") {
      this.onOpenSession?.(conversation.id);
      return;
    }
    if (this.busy) return;
    this.promoting = true;
    this.error = null;
    try {
      const vaultId = selectedVault();
      await continueAsSession(conversation.id);
      if (this.#controller.signal.aborted) return;
      this.conversation = { ...conversation, kind: "session" };
      await queryClient.invalidateQueries({ queryKey: ["vault", vaultId, "sessions"] });
      if (!this.#controller.signal.aborted) this.onOpenSession?.(conversation.id);
    } catch (error) {
      if (isAbortError(error) || this.#controller.signal.aborted) return;
      this.error = "Couldn't continue as a session. Try again.";
    } finally {
      this.promoting = false;
    }
  };
}
