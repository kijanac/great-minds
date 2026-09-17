import { browser } from "$app/environment";
import type { OriginSessionDetail, SessionId, SessionOrigin, Uuid } from "@great-minds/domain";

import {
  createReply,
  retryReply,
  streamReply,
  type CreateReplyPayload,
  type CreateReplyResponse,
} from "$lib/api/replies";
import { selectedVault } from "$lib/api/selected-vault";
import { continueAsSession } from "$lib/api/sessions";
import { newUuid } from "$lib/ids";
import { queryClient } from "$lib/query-client";
import { replyTurn } from "$lib/reply-turn";
import { replayExchanges } from "$lib/session-events";
import type { Exchange, ThreadLike } from "$lib/types";
import { genId, isAbortError } from "$lib/utils";

export class Btw implements ThreadLike {
  conversation = $state<ThreadLike["conversation"]>(null);
  exchanges = $state<Exchange[]>([]);
  promoting = $state(false);
  error = $state<string | null>(null);

  readonly id: string;
  readonly anchor: ThreadLike["anchor"];
  readonly createdAt: Date | null;

  #controller = new AbortController();
  #attempt: CreateReplyPayload | null = null;

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
    this.exchanges = saved ? replayExchanges(saved.events) : [];
    if (browser) {
      queueMicrotask(() => {
        const pending = this.exchanges.at(-1);
        if (
          !this.#controller.signal.aborted &&
          this.conversation?.kind === "btw" &&
          pending?.streaming &&
          pending.replyId
        ) {
          void this.#tail(pending.id, pending.replyId);
        }
      });
    }
  }

  get draft(): boolean {
    return this.conversation === null;
  }

  get #busy(): boolean {
    return (
      this.#controller.signal.aborted ||
      this.promoting ||
      this.exchanges.some((turn) => turn.streaming)
    );
  }

  destroy = (): void => {
    this.#controller.abort();
    this.#attempt = null;
  };

  #patchTurn = (turnId: Uuid, patch: Partial<Exchange>): void => {
    this.exchanges = this.exchanges.map((turn) =>
      turn.id === turnId ? { ...turn, ...patch } : turn,
    );
  };

  #tail = async (turnId: Uuid, replyId: Uuid): Promise<void> => {
    try {
      for await (const snapshot of streamReply(replyId, this.#controller.signal)) {
        this.#patchTurn(turnId, replyTurn(snapshot));
      }
    } catch (error) {
      if (isAbortError(error) || this.#controller.signal.aborted) return;
      this.#patchTurn(turnId, {
        streaming: false,
        error: "Couldn't reconnect to this BTW. Try again.",
      });
    }
  };

  #runReply = async (
    previous: Exchange,
    request: () => Promise<CreateReplyResponse>,
  ): Promise<void> => {
    this.#patchTurn(previous.id, { thinking: [], answer: "", streaming: true, error: null });
    try {
      const created = await request();
      if (this.#controller.signal.aborted) return;
      this.conversation ??= { id: created.session_id, kind: "btw", query: previous.query };
      this.#attempt = null;
      this.#patchTurn(previous.id, { replyId: created.reply_id });
      await this.#tail(previous.id, created.reply_id);
    } catch (error) {
      if (isAbortError(error) || this.#controller.signal.aborted) return;
      this.#patchTurn(previous.id, {
        ...previous,
        streaming: false,
        error: "Couldn't send this BTW. Try again.",
      });
    }
  };

  reply = (question: string): void => {
    if (this.#busy || this.conversation?.kind === "session") return;
    const turn: Exchange = {
      id: newUuid(),
      query: question,
      thinking: [],
      answer: "",
      btws: [],
      streaming: false,
    };
    const scope = this.origin.kind === "document" ? this.origin.origin_scope : "vault";
    const payload: CreateReplyPayload = {
      reply_id: newUuid(),
      exchange_id: turn.id,
      question,
      origin_scope: scope,
      mode: "btw",
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
    this.#attempt = payload;
    this.exchanges = [...this.exchanges, turn];
    void this.#runReply(turn, () => createReply(payload, this.#controller.signal));
  };

  retry = (turnId: Uuid): void => {
    const previous = this.exchanges.at(-1);
    if (this.#busy || this.conversation?.kind === "session" || previous?.id !== turnId) return;
    const replyId = previous.replyId;
    const attempt = this.#attempt;
    if (replyId) {
      void this.#runReply(previous, () => retryReply(replyId, newUuid(), this.#controller.signal));
    } else if (attempt) {
      void this.#runReply(previous, () => createReply(attempt, this.#controller.signal));
    }
  };

  openSession = async (): Promise<void> => {
    const conversation = this.conversation;
    if (!conversation || this.#controller.signal.aborted || this.promoting) return;
    if (conversation.kind === "session") {
      this.onOpenSession?.(conversation.id);
      return;
    }
    if (this.#busy) return;
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
