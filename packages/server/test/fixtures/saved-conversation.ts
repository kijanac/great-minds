import { Database, sessions } from "@great-minds/database";
import { SessionId, SessionOrigin, ThinkingSource, Uuid } from "@great-minds/domain";
import { and, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { HistoryStore } from "../../src/conversation-history/store.ts";
import { HistoryTimestamp, type HistoryWrite } from "../../src/conversation-history/schema.ts";
import { LlmMessageSchema } from "../../src/llm.ts";

export const ConversationTurnFixture = Schema.Struct({
  replyId: Uuid,
  exchangeId: Uuid,
  question: Schema.String,
  answer: Schema.String,
  timestamp: HistoryTimestamp,
  parentReplyId: Schema.optionalKey(Schema.NullOr(Uuid)),
  messages: Schema.optionalKey(Schema.Array(LlmMessageSchema)),
  sources: Schema.optionalKey(Schema.Array(ThinkingSource)),
});
export type ConversationTurnFixture = typeof ConversationTurnFixture.Type;

export const savedConversation = (
  vaultId: Uuid,
  sessionId: SessionId,
  turns: readonly [ConversationTurnFixture, ...ConversationTurnFixture[]],
  context: { readonly session_id: SessionId; readonly reply_id: Uuid } | null = null,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const histories = yield* HistoryStore;
    const rows = yield* db.query((d) =>
      d
        .select()
        .from(sessions)
        .where(and(eq(sessions.vaultId, vaultId), eq(sessions.id, sessionId))),
    );
    const row = rows[0];
    if (row === undefined) throw new Error("Saved conversation fixture requires its metadata row");
    const origin = Schema.decodeUnknownSync(Schema.NullOr(SessionOrigin))(row.origin);
    const writes: HistoryWrite[] = [
      {
        type: "conversation",
        format: "great-minds/conversation",
        version: 1,
        session_id: sessionId,
        author_id: row.userId,
        created_at: Schema.decodeUnknownSync(HistoryTimestamp)(row.createdAt.toISOString()),
        origin,
        context,
        anchor_reply_id: origin?.kind === "answer" ? (context?.reply_id ?? null) : null,
      },
    ];
    for (const turn of turns) {
      writes.push(
        {
          type: "attempt",
          reply_id: turn.replyId,
          exchange_id: turn.exchangeId,
          previous_attempt_id: null,
          parent_reply_id: turn.parentReplyId ?? null,
          question: turn.question,
          accepted_at: turn.timestamp,
        },
        {
          type: "settlement",
          reply_id: turn.replyId,
          settled_at: turn.timestamp,
          outcome: { status: "completed" },
          answer: turn.answer,
          sources: turn.sources ?? [],
          generation: null,
          context_messages: turn.messages ?? [
            { role: "user", content: turn.question },
            { role: "assistant", content: turn.answer },
          ],
        },
      );
    }
    const saved = yield* histories.commit({ vault_id: vaultId, session_id: sessionId }, writes);
    yield* db.query((d) =>
      d
        .update(sessions)
        .set({
          historySeq: saved.history.revision.last_seq,
          historySha256: saved.history.revision.sha256,
        })
        .where(and(eq(sessions.vaultId, vaultId), eq(sessions.id, sessionId))),
    );
  });

export type SavedConversationServices = Effect.Services<ReturnType<typeof savedConversation>>;
