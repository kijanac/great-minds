import { isDeepStrictEqual } from "node:util";

import { Database, type TransactionClient, replies, sessions } from "@great-minds/database";
import type { ThinkingSource, Uuid } from "@great-minds/domain";
import { and, eq, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer, Result, Schema } from "effect";

import { ClockService } from "../clock.ts";
import type { LlmMessage } from "../llm.ts";
import { type ConversationHistory, type HistoryRevision, verifyHistoryReceipt } from "./history.ts";
import { type GenerationMetadata, HistorySettlementWrite, HistoryTimestamp } from "./schema.ts";
import { type HistoryCommitError, HistoryStore, type HistoryStoreShape } from "./store.ts";

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
  readonly restoreRecorded: (
    replyId: Uuid,
  ) => Effect.Effect<void, ReplySettlementInvalid | HistoryCommitError>;
  readonly begin: (
    replyId: Uuid,
    result: ReplySettlementResult,
  ) => Effect.Effect<boolean, ReplySettlementInvalid>;
  readonly publish: (
    replyId: Uuid,
  ) => Effect.Effect<boolean, ReplySettlementInvalid | HistoryCommitError>;
}

export class ReplySettlement extends Context.Service<ReplySettlement, ReplySettlementShape>()(
  "@great-minds/server/ReplySettlement",
) {}

export const ReplySettlementLive = Layer.effect(
  ReplySettlement,
  Effect.gen(function* () {
    const db = yield* Database;
    const histories = yield* HistoryStore;
    const clock = yield* ClockService;
    return makeReplySettlement(db, histories, clock);
  }),
);

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
  const readOperation = (replyId: Uuid) =>
    db
      .query((client) =>
        client
          .select({ reply: replies, session: sessions })
          .from(replies)
          .innerJoin(
            sessions,
            and(eq(sessions.id, replies.sessionId), eq(sessions.vaultId, replies.vaultId)),
          )
          .where(eq(replies.id, replyId))
          .limit(1),
      )
      .pipe(Effect.map((rows) => rows[0]));

  const projectRecorded = (
    tx: TransactionClient,
    locked: { readonly session: typeof sessions.$inferSelect; readonly reply: ReplyRow },
    history: ConversationHistory,
    payload: HistorySettlementWrite,
  ) =>
    Effect.gen(function* () {
      const previousReceipt = yield* receiptFor(locked.session, locked.reply.id);
      const verified = verifyHistoryReceipt(history, previousReceipt);
      if (Result.isFailure(verified)) return yield* verified.failure;
      const row = locked.reply;
      const now = yield* clock.now;
      yield* tx
        .update(sessions)
        .set({
          historySeq: history.revision.last_seq,
          historySha256: history.revision.sha256,
          updatedAt:
            payload.settled_at === null
              ? sql`${sessions.updatedAt}`
              : sql`greatest(${sessions.updatedAt}, ${new Date(payload.settled_at)})`,
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
    });

  const restoreRecorded = (replyId: Uuid) =>
    Effect.gen(function* () {
      const initial = yield* readOperation(replyId);
      if (initial === undefined || initial.reply.status !== "running") return;
      const receipt = yield* receiptFor(initial.session, replyId);
      const file = yield* histories.read(
        { vault_id: initial.reply.vaultId, session_id: initial.reply.sessionId },
        receipt,
      );
      if (file === null)
        return yield* new ReplySettlementInvalid({ reply_id: replyId, reason: "history_receipt" });
      const recorded = file.history.records.find(
        (record) => record.type === "settlement" && record.reply_id === replyId,
      );
      if (recorded === undefined || recorded.type !== "settlement") return;
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const locked = yield* lockConversationReply(tx, initial.reply);
          if (locked === null || locked.reply.status !== "running") return;
          yield* projectRecorded(tx, locked, file.history, recorded);
        }),
      );
    });

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
      const initial = yield* readOperation(replyId);
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
          const { reply: row } = locked;
          const frozen = yield* settlementFor(row);
          if (!isDeepStrictEqual(frozen, payload)) {
            return yield* new ReplySettlementInvalid({
              reply_id: replyId,
              reason: "settlement_payload",
            });
          }
          yield* projectRecorded(tx, locked, committed.history, payload);
          return true;
        }),
      );
    });

  return { begin, publish, restoreRecorded } satisfies ReplySettlementShape;
};
