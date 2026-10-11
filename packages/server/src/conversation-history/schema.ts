import {
  FileFingerprint,
  SessionId,
  SessionOrigin,
  ThinkingSource,
  Uuid,
} from "@great-minds/domain";
import { Schema } from "effect";

import { LlmMessageSchema } from "../llm.ts";

export const HistoryTimestamp = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => {
      const time = Date.parse(value);
      return Number.isFinite(time) && new Date(time).toISOString() === value;
    }),
  ),
  Schema.brand("HistoryTimestamp"),
);

const Sequence = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
);

const GenerationMetadata = Schema.Struct({
  mode: Schema.Literals(["btw", "query"]),
  system_prompt_hash: Schema.Struct({
    scheme: Schema.Literal("gm-prompt-v1"),
    value: FileFingerprint,
  }),
  requested_model: Schema.NonEmptyString,
  last_model: Schema.optionalKey(Schema.NonEmptyString),
});

const Outcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed") }),
  Schema.Struct({ status: Schema.Literal("stopped") }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    code: Schema.Literals([
      "generation_failed",
      "external_outcome_unknown",
      "recovery_interrupted",
    ]),
    message: Schema.String,
  }),
]);

const headerFields = {
  type: Schema.Literal("conversation"),
  format: Schema.Literal("great-minds/conversation"),
  version: Schema.Literal(1),
  session_id: SessionId,
  created_at: HistoryTimestamp,
  author_id: Uuid,
  origin: Schema.NullOr(Schema.toType(SessionOrigin)),
  anchor_reply_id: Schema.NullOr(Uuid),
  context: Schema.NullOr(Schema.Struct({ session_id: SessionId, reply_id: Uuid })),
};

const attemptFields = {
  type: Schema.Literal("attempt"),
  reply_id: Uuid,
  exchange_id: Uuid,
  previous_attempt_id: Schema.NullOr(Uuid),
  parent_reply_id: Schema.NullOr(Uuid),
  question: Schema.String,
  accepted_at: Schema.NullOr(HistoryTimestamp),
};

const settlementFields = {
  type: Schema.Literal("settlement"),
  reply_id: Uuid,
  settled_at: Schema.NullOr(HistoryTimestamp),
  outcome: Outcome,
  answer: Schema.String,
  sources: Schema.Array(ThinkingSource),
  context_messages: Schema.NullOr(Schema.Array(LlmMessageSchema)),
  generation: Schema.NullOr(GenerationMetadata),
};

export const HistoryHeader = Schema.Struct({ ...headerFields, seq: Schema.Literal(1) });
export type HistoryHeader = typeof HistoryHeader.Type;

export const HistoryAttempt = Schema.Struct({ ...attemptFields, seq: Sequence });
export type HistoryAttempt = typeof HistoryAttempt.Type;

export const HistorySettlement = Schema.Struct({ ...settlementFields, seq: Sequence });
export type HistorySettlement = typeof HistorySettlement.Type;

export const HistoryRecord = Schema.Union([HistoryHeader, HistoryAttempt, HistorySettlement]);
export type HistoryRecord = typeof HistoryRecord.Type;

export const HistoryWrite = Schema.Union([
  Schema.Struct(headerFields),
  Schema.Struct(attemptFields),
  Schema.Struct(settlementFields),
]);
export type HistoryWrite = typeof HistoryWrite.Type;
