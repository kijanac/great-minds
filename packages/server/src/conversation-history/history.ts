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
  readonly selected_reply_id: Uuid;
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
  const turns = new Map<
    Uuid,
    { exchange_id: Uuid; selected_reply_id: Uuid; attempts: SettledOrPendingAttempt[] }
  >();
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
          selected_reply_id: record.reply_id,
          attempts: [attempt],
        });
      } else {
        turn.selected_reply_id = record.reply_id;
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
  const prefix = history.jsonl.split("\n").slice(0, receipt.last_seq).join("\n") + "\n";
  if (
    !Number.isSafeInteger(receipt.last_seq) ||
    receipt.last_seq < 1 ||
    receipt.last_seq > history.revision.last_seq ||
    rawFileHash(encoder.encode(prefix)) !== receipt.sha256
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

export type HistoryDependencyIssue = {
  readonly session_id: SessionId;
  readonly dependency_id: SessionId;
  readonly reason:
    | "missing_history"
    | "missing_reply"
    | "unusable_context"
    | "anchor_mismatch"
    | "context_cycle";
};

export const inspectHistoryDependencies = (
  histories: readonly ConversationHistory[],
): readonly HistoryDependencyIssue[] => {
  const byId = new Map(histories.map((history) => [history.header.session_id, history]));
  const issues: HistoryDependencyIssue[] = [];
  for (const history of histories) {
    const sessionId = history.header.session_id;
    const context = history.header.context;
    const origin = history.header.origin;
    const anchor = history.header.anchor_reply_id;
    const references = [
      ...(context === null ? [] : [{ ...context, kind: "context" as const }]),
      ...(origin?.kind === "answer" && anchor !== null
        ? [{ session_id: origin.session_id, reply_id: anchor, kind: "anchor" as const }]
        : []),
    ];
    for (const reference of references) {
      const dependency = byId.get(reference.session_id);
      const attempt = dependency?.turns
        .flatMap((turn) => turn.attempts)
        .find((attempt) => attempt.accepted.reply_id === reference.reply_id);
      let reason: HistoryDependencyIssue["reason"] | undefined;
      if (dependency === undefined) reason = "missing_history";
      else if (attempt === undefined) reason = "missing_reply";
      else if (
        reference.kind === "context" &&
        (attempt.settlement === null ||
          attempt.settlement.outcome.status === "failed" ||
          attempt.settlement.context_messages === null)
      ) {
        reason = "unusable_context";
      } else if (
        reference.kind === "anchor" &&
        origin?.kind === "answer" &&
        (attempt.accepted.exchange_id !== origin.exchange_id ||
          attempt.settlement === null ||
          attempt.settlement.outcome.status === "failed")
      ) {
        reason = "anchor_mismatch";
      }
      if (reason !== undefined)
        issues.push({ session_id: sessionId, dependency_id: reference.session_id, reason });
    }
    const visited = new Set<SessionId>([sessionId]);
    let parent = context?.session_id;
    while (parent !== undefined) {
      if (visited.has(parent)) {
        issues.push({ session_id: sessionId, dependency_id: parent, reason: "context_cycle" });
        break;
      }
      visited.add(parent);
      parent = byId.get(parent)?.header.context?.session_id;
    }
  }
  return issues;
};
