import { isDeepStrictEqual } from "node:util";

import type { FileFingerprint, SessionId, Uuid } from "@great-minds/domain";
import { Data, Result, Schema } from "effect";

import { rawFileHash } from "../crypto.ts";
import {
  type HistoryAttempt,
  type HistoryHeader,
  HistoryRecord,
  type HistorySettlement,
  type HistoryWrite,
} from "./schema.ts";

export class HistoryInvalid extends Data.TaggedError("HistoryInvalid")<{
  readonly session_id: SessionId;
  readonly line: number | null;
  readonly reason:
    | "invalid_utf8"
    | "missing_newline"
    | "empty_history"
    | "blank_line"
    | "invalid_json"
    | "unsupported_format"
    | "invalid_record"
    | "sequence"
    | "header"
    | "duplicate_record"
    | "missing_attempt"
    | "attempt_predecessor"
    | "context_parent"
    | "origin"
    | "source_range"
    | "history_receipt";
}> {}

export class HistoryConflict extends Data.TaggedError("HistoryConflict")<{
  readonly session_id: SessionId;
  readonly record: string;
}> {}

export type HistoryRevision = {
  readonly last_seq: number;
  readonly sha256: FileFingerprint;
};

export type SettledOrPendingAttempt = {
  readonly accepted: HistoryAttempt;
  readonly settlement: HistorySettlement | null;
};

export type HistoryTurn = {
  readonly exchange_id: Uuid;
  readonly attempts: readonly SettledOrPendingAttempt[];
};

const parsedHistory: unique symbol = Symbol("ParsedConversationHistory");

export type ConversationHistory = {
  readonly [parsedHistory]: true;
  readonly header: HistoryHeader;
  readonly records: readonly HistoryRecord[];
  readonly turns: readonly HistoryTurn[];
  readonly revision: HistoryRevision;
  readonly jsonl: string;
};

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const decodeRecord = Schema.decodeUnknownResult(HistoryRecord, { onExcessProperty: "error" });
const encodeRecord = Schema.encodeSync(HistoryRecord, { onExcessProperty: "error" });
const decodeFormat = Schema.decodeUnknownResult(
  Schema.Struct({
    type: Schema.Literal("conversation"),
    format: Schema.Literal("great-minds/conversation"),
    version: Schema.Literal(1),
  }),
);

const recordKey = (record: HistoryWrite) =>
  record.type === "conversation"
    ? `conversation:${record.session_id}`
    : `${record.type}:${record.reply_id}`;

const withoutSequence = ({ seq: _seq, ...write }: HistoryRecord): HistoryWrite => write;

const reduceRecords = (
  sessionId: SessionId,
  records: readonly HistoryRecord[],
  jsonl: string,
): Result.Result<ConversationHistory, HistoryInvalid> => {
  const invalid = (reason: HistoryInvalid["reason"], line: number | null) =>
    Result.fail(new HistoryInvalid({ session_id: sessionId, line, reason }));
  const header = records[0];
  if (header?.type !== "conversation" || header.session_id !== sessionId)
    return invalid("header", 1);
  if (
    (header.origin?.kind !== "answer" && header.anchor_reply_id !== null) ||
    (header.origin?.kind === "answer" && header.origin.session_id === sessionId) ||
    header.context?.session_id === sessionId ||
    (header.origin?.paragraph_index != null && !Number.isSafeInteger(header.origin.paragraph_index))
  )
    return invalid("origin", 1);

  const identities = new Set<string>();
  const attempts = new Map<
    Uuid,
    { accepted: HistoryAttempt; settlement: HistorySettlement | null }
  >();
  const turns = new Map<Uuid, { exchange_id: Uuid; attempts: SettledOrPendingAttempt[] }>();
  for (const [index, record] of records.entries()) {
    const line = index + 1;
    if (record.seq !== line) return invalid("sequence", line);
    const identity = recordKey(record);
    if (identities.has(identity)) return invalid("duplicate_record", line);
    identities.add(identity);
    if (record.type === "conversation") {
      if (index !== 0) return invalid("header", line);
      continue;
    }
    if (record.type === "attempt") {
      const turn = turns.get(record.exchange_id);
      const previous = turn?.attempts.at(-1)?.accepted;
      if (
        record.previous_attempt_id !== (previous?.reply_id ?? null) ||
        (previous !== undefined && previous.parent_reply_id !== record.parent_reply_id)
      )
        return invalid("attempt_predecessor", line);
      if (record.parent_reply_id !== null) {
        const parent = attempts.get(record.parent_reply_id);
        if (parent?.settlement == null || parent.settlement.outcome.status === "failed") {
          return invalid("context_parent", line);
        }
      }
      const attempt = { accepted: record, settlement: null };
      attempts.set(record.reply_id, attempt);
      if (turn === undefined) {
        turns.set(record.exchange_id, {
          exchange_id: record.exchange_id,
          attempts: [attempt],
        });
      } else {
        turn.attempts.push(attempt);
      }
      continue;
    }
    const attempt = attempts.get(record.reply_id);
    if (attempt === undefined) return invalid("missing_attempt", line);
    if (
      record.sources.some((source) =>
        source.ranges?.some(
          (range) =>
            !Number.isSafeInteger(range.start) ||
            !Number.isSafeInteger(range.end) ||
            range.start < 0 ||
            range.end < range.start,
        ),
      )
    )
      return invalid("source_range", line);
    attempt.settlement = record;
  }
  if (attempts.size === 0) return invalid("empty_history", null);
  return Result.succeed({
    [parsedHistory]: true as const,
    header,
    records,
    turns: [...turns.values()],
    revision: { last_seq: records.length, sha256: rawFileHash(encoder.encode(jsonl)) },
    jsonl,
  });
};

export const parseHistory = (
  sessionId: SessionId,
  bytes: Uint8Array,
): Result.Result<ConversationHistory, HistoryInvalid> => {
  const invalid = (reason: HistoryInvalid["reason"], line: number | null) =>
    Result.fail(new HistoryInvalid({ session_id: sessionId, line, reason }));
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return invalid("invalid_utf8", null);
  }
  if (text.length === 0) return invalid("empty_history", null);
  if (!text.endsWith("\n")) return invalid("missing_newline", null);
  const records: HistoryRecord[] = [];
  for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
    if (line.trim().length === 0) return invalid("blank_line", index + 1);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return invalid("invalid_json", index + 1);
    }
    if (index === 0 && Result.isFailure(decodeFormat(value)))
      return invalid("unsupported_format", 1);
    const record = decodeRecord(value);
    if (Result.isFailure(record)) return invalid("invalid_record", index + 1);
    records.push(record.success);
  }
  return reduceRecords(sessionId, records, text);
};

export const planHistoryAppend = (
  sessionId: SessionId,
  current: ConversationHistory | null,
  writes: readonly HistoryWrite[],
): Result.Result<
  {
    readonly history: ConversationHistory;
    readonly changed: boolean;
  },
  HistoryInvalid | HistoryConflict
> => {
  if (current !== null && current.header.session_id !== sessionId) {
    return Result.fail(new HistoryInvalid({ session_id: sessionId, reason: "header", line: 1 }));
  }
  const records = [...(current?.records ?? [])];
  const identities = new Map(records.map((record) => [recordKey(record), withoutSequence(record)]));
  let jsonl = current?.jsonl ?? "";
  for (const write of structuredClone(writes)) {
    const key = recordKey(write);
    const previous = identities.get(key);
    if (previous !== undefined) {
      if (!isDeepStrictEqual(previous, write)) {
        return Result.fail(new HistoryConflict({ session_id: sessionId, record: key }));
      }
      continue;
    }
    const record: HistoryRecord =
      write.type === "conversation" ? { ...write, seq: 1 } : { ...write, seq: records.length + 1 };
    records.push(record);
    identities.set(key, write);
    jsonl += `${JSON.stringify(encodeRecord(record))}\n`;
  }
  if (current !== null && records.length === current.records.length) {
    return Result.succeed({ history: current, changed: false });
  }
  return Result.map(reduceRecords(sessionId, records, jsonl), (history) => ({
    history,
    changed: true,
  }));
};

export const verifyHistoryReceipt = (
  history: ConversationHistory,
  receipt: HistoryRevision,
): Result.Result<void, HistoryInvalid> => {
  if (
    !Number.isSafeInteger(receipt.last_seq) ||
    receipt.last_seq < 1 ||
    receipt.last_seq > history.revision.last_seq ||
    (receipt.last_seq === history.revision.last_seq
      ? history.revision.sha256
      : rawFileHash(
          encoder.encode(history.jsonl.split("\n").slice(0, receipt.last_seq).join("\n") + "\n"),
        )) !== receipt.sha256
  ) {
    return Result.fail(
      new HistoryInvalid({
        session_id: history.header.session_id,
        line: null,
        reason: "history_receipt",
      }),
    );
  }
  return Result.succeed(undefined);
};
