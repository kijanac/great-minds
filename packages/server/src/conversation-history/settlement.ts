import { isDeepStrictEqual } from "node:util";

import { type Database, type TransactionClient, replies, sessions } from "@great-minds/database";
import type { ThinkingSource, Uuid } from "@great-minds/domain";
import { and, eq, sql } from "drizzle-orm";
import { Data, Effect, Result, Schema } from "effect";

import type { ClockService } from "../clock.ts";
import type { LlmMessage } from "../llm.ts";
import { type HistoryRevision, verifyHistoryReceipt } from "./history.ts";
import { type GenerationMetadata, HistorySettlementWrite, HistoryTimestamp } from "./schema.ts";
import type { HistoryCommitError, HistoryStoreShape } from "./store.ts";

export type ReplySettlementResult =
  | {
      readonly status: "completed";
      readonly answer: string;
      readonly sources: readonly ThinkingSource[];
      readonly context_messages: readonly LlmMessage[];
      readonly generation: GenerationMetadata;
    }
  | {
      readonly status: "stopped";
      readonly context_messages: readonly LlmMessage[] | null;
      readonly generation: GenerationMetadata | null;
    }
  | {
      readonly status: "failed";
      readonly code: Extract<HistorySettlementWrite["outcome"], { status: "failed" }>["code"];
      readonly message: string;
      readonly context_messages: readonly LlmMessage[] | null;
      readonly generation: GenerationMetadata | null;
    };

export class ReplySettlementInvalid extends Data.TaggedError("ReplySettlementInvalid")<{
  readonly reply_id: Uuid;
  readonly reason: "history_receipt" | "settlement_payload" | "settlement_identity";
}> {}

export interface ReplySettlementShape {
  readonly begin: (
    replyId: Uuid,
    result: ReplySettlementResult,
  ) => Effect.Effect<boolean, ReplySettlementInvalid>;
  readonly publish: (
    replyId: Uuid,
  ) => Effect.Effect<boolean, ReplySettlementInvalid | HistoryCommitError>;
}

const NativeSettlement = Schema.Struct({
  ...HistorySettlementWrite.fields,
  settled_at: HistoryTimestamp,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (record) =>
        record.outcome.status !== "completed" ||
        (record.generation !== null && record.context_messages !== null),
    ),
  ),
);
const decodeSettlement = Schema.decodeUnknownEffect(NativeSettlement, {
  onExcessProperty: "error",
});
const encodeSettlement = Schema.encodeSync(NativeSettlement, { onExcessProperty: "error" });
type ReplyRow = typeof replies.$inferSelect;

const receiptFor = (session: typeof sessions.$inferSelect, replyId: Uuid) =>
  Effect.gen(function* () {
    if (session.historySeq === null || session.historySha256 === null) {
      return yield* new ReplySettlementInvalid({ reply_id: replyId, reason: "history_receipt" });
    }
    return {
      last_seq: session.historySeq,
      sha256: session.historySha256,
    } satisfies HistoryRevision;
  });

const lockConversationReply = (
  tx: TransactionClient,
  identity: Pick<ReplyRow, "id" | "sessionId" | "vaultId">,
) =>
  Effect.gen(function* () {
    const [session] = yield* tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, identity.sessionId), eq(sessions.vaultId, identity.vaultId)))
      .limit(1)
      .for("update");
    if (session === undefined) return null;
    const [reply] = yield* tx
      .select()
      .from(replies)
      .where(
        and(
          eq(replies.id, identity.id),
          eq(replies.sessionId, identity.sessionId),
          eq(replies.vaultId, identity.vaultId),
        ),
      )
      .limit(1)
      .for("update");
    return reply === undefined ? null : { session, reply };
  });

const settlementFor = (row: ReplyRow) =>
  Effect.gen(function* () {
    const payload = yield* decodeSettlement(row.settlement).pipe(
      Effect.mapError(
        () => new ReplySettlementInvalid({ reply_id: row.id, reason: "settlement_payload" }),
      ),
    );
    if (payload.reply_id !== row.id) {
      return yield* new ReplySettlementInvalid({ reply_id: row.id, reason: "settlement_identity" });
    }
    return payload;
  });

export const stoppedMessages = (
  messages: readonly LlmMessage[],
  answer: string,
): readonly LlmMessage[] => {
  const results = new Set(
    messages.flatMap((message) => (message.role === "tool" ? [message.tool_call_id] : [])),
  );
  const pending = messages
    .flatMap((message) => (message.role === "assistant" ? (message.tool_calls ?? []) : []))
    .filter((call) => !results.has(call.id));
  const lastAnswer = messages.findLast((message) => message.role === "assistant");
  return [
    ...messages,
    ...pending.map((call): LlmMessage => ({
      role: "tool",
      tool_call_id: call.id,
      content: "Tool call cancelled because the user stopped the response.",
    })),
    ...(answer.length > 0 && lastAnswer?.content !== answer
      ? [{ role: "assistant" as const, content: answer }]
      : []),
  ];
};

export const makeReplySettlement = (
  db: Database["Service"],
  histories: HistoryStoreShape,
  clock: ClockService["Service"],
) => {
  const begin = (replyId: Uuid, result: ReplySettlementResult) =>
    Effect.gen(function* () {
      const [identity] = yield* db.query((client) =>
        client
          .select({
            id: replies.id,
            sessionId: replies.sessionId,
            vaultId: replies.vaultId,
          })
          .from(replies)
          .where(eq(replies.id, replyId))
          .limit(1),
      );
      if (identity === undefined) return false;
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const locked = yield* lockConversationReply(tx, identity);
          if (locked === null) return false;
          const row = locked.reply;
          if (row.status === "settling") {
            yield* settlementFor(row);
            return true;
          }
          if (row.status !== "running") return false;
          yield* receiptFor(locked.session, replyId);
          const now = yield* clock.now;
          const stopped = row.stopRequested || result.status === "stopped";
          const answer = !stopped && result.status === "completed" ? result.answer : row.answer;
          const sources =
            !stopped && result.status === "completed"
              ? result.sources
              : row.sources.flatMap(({ pending, ...source }) => (pending === true ? [] : [source]));
          const payload = {
            type: "settlement",
            reply_id: row.id,
            settled_at: HistoryTimestamp.make(now.toISOString()),
            outcome: stopped
              ? { status: "stopped" }
              : result.status === "failed"
                ? { status: "failed", code: result.code, message: result.message }
                : { status: "completed" },
            answer,
            sources,
            context_messages:
              stopped && result.context_messages !== null
                ? stoppedMessages(result.context_messages, answer)
                : result.context_messages,
            generation: result.generation,
          } satisfies HistorySettlementWrite;
          yield* tx
            .update(replies)
            .set({
              status: "settling",
              settlement: encodeSettlement(payload),
              version: sql`${replies.version} + 1`,
              updatedAt: now,
            })
            .where(eq(replies.id, replyId));
          return true;
        }),
      );
    });

  const publish = (replyId: Uuid) =>
    Effect.gen(function* () {
      const [initial] = yield* db.query((client) =>
        client
          .select({ reply: replies, session: sessions })
          .from(replies)
          .innerJoin(
            sessions,
            and(eq(sessions.id, replies.sessionId), eq(sessions.vaultId, replies.vaultId)),
          )
          .where(eq(replies.id, replyId))
          .limit(1),
      );
      if (initial === undefined || initial.reply.status !== "settling") return false;
      const payload = yield* settlementFor(initial.reply);
      const receipt = yield* receiptFor(initial.session, replyId);
      const committed = yield* histories.commit(
        {
          vault_id: initial.reply.vaultId,
          session_id: initial.reply.sessionId,
        },
        [payload],
        receipt,
      );

      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const locked = yield* lockConversationReply(tx, initial.reply);
          if (locked === null || locked.reply.status !== "settling") return false;
          const { session, reply: row } = locked;
          const frozen = yield* settlementFor(row);
          if (!isDeepStrictEqual(frozen, payload)) {
            return yield* new ReplySettlementInvalid({
              reply_id: replyId,
              reason: "settlement_payload",
            });
          }
          const previousReceipt = yield* receiptFor(session, replyId);
          const verified = verifyHistoryReceipt(committed.history, previousReceipt);
          if (Result.isFailure(verified)) return yield* verified.failure;
          const nextReceipt = committed.history.revision;
          const now = yield* clock.now;
          yield* tx
            .update(sessions)
            .set({
              historySeq: nextReceipt.last_seq,
              historySha256: nextReceipt.sha256,
              updatedAt: sql`greatest(${sessions.updatedAt}, ${new Date(payload.settled_at)})`,
            })
            .where(and(eq(sessions.id, row.sessionId), eq(sessions.vaultId, row.vaultId)));
          yield* tx
            .update(replies)
            .set({
              status: payload.outcome.status,
              answer: payload.answer,
              sources: payload.sources,
              error: payload.outcome.status === "failed" ? payload.outcome.message : null,
              settlement: null,
              activeGenerationStep: null,
              activeGenerationKind: null,
              activeGenerationKey: null,
              version: sql`${replies.version} + 1`,
              updatedAt: now,
            })
            .where(eq(replies.id, row.id));
          return true;
        }),
      );
    });

  return { begin, publish } satisfies ReplySettlementShape;
};
