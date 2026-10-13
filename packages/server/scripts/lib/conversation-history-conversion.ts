import { isDeepStrictEqual } from "node:util";

import { FileFingerprint, ReplySource, SessionId, SessionOrigin, Uuid } from "@great-minds/domain";
import { Result, Schema } from "effect";

import { AcceptedReplyRequest } from "../../src/conversation-history/admission.ts";
import {
  inspectHistoryDependencies,
  planHistoryAppend,
  type ConversationHistory,
} from "../../src/conversation-history/history.ts";
import {
  HistoryTimestamp,
  type GenerationMetadata,
  type HistoryAttemptWrite,
  type HistoryHeaderWrite,
  type HistorySettlementWrite,
  type HistoryWrite,
} from "../../src/conversation-history/schema.ts";
import { promptContentHash, rawFileHash } from "../../src/crypto.ts";
import { LlmMessageSchema } from "../../src/llm.ts";
import {
  CreateReplyRequest as LegacyRequest,
  ReplyNode,
  StoredSessionEvent,
} from "./legacy-session-history.ts";

const CapturedTime = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)))),
);
const Counter = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));
const ObjectKey = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) =>
        value.length > 0 &&
        !value.includes("\\") &&
        !value.includes("\0") &&
        value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    ),
  ),
);
const SessionRow = Schema.Struct({
  id: SessionId,
  vault_id: Uuid,
  user_id: Uuid,
  query: Schema.String,
  origin: Schema.NullOr(Schema.toType(SessionOrigin)),
  kind: Schema.Literals(["session", "btw"]),
  created_at: CapturedTime,
  updated_at: CapturedTime,
  idempotency_key: Schema.NullOr(Schema.String),
});
const ReplyRow = Schema.Struct({
  id: Uuid,
  vault_id: Uuid,
  user_id: Uuid,
  session_id: SessionId,
  kind: Schema.Literals(["exchange", "btw"]),
  status: Schema.Literals(["running", "completed", "failed", "stopped"]),
  stop_requested: Schema.Boolean,
  answer: Schema.String,
  sources: Schema.Array(ReplySource),
  error: Schema.NullOr(Schema.String),
  version: Counter,
  request: Schema.Unknown,
  dispatched_at: Schema.NullOr(CapturedTime),
  dispatched_task_id: Schema.NullOr(Uuid),
  generation_cursor: Counter,
  active_generation_step: Schema.NullOr(Counter),
  active_generation_kind: Schema.NullOr(Schema.String),
  active_generation_key: Schema.NullOr(Schema.String),
  created_at: CapturedTime,
  updated_at: CapturedTime,
});
export const ConversationSnapshot = Schema.Struct({
  format: Schema.Literal("great-minds/legacy-conversation-snapshot"),
  version: Schema.Literal(1),
  database_sha256: FileFingerprint,
  controls: Schema.Array(Schema.Struct({ table: Schema.String, sha256: FileFingerprint })),
  sessions: Schema.Array(SessionRow),
  replies: Schema.Array(ReplyRow),
  objects: Schema.Array(Schema.Struct({ key: ObjectKey, sha256: FileFingerprint })),
});
export type ConversationSnapshot = typeof ConversationSnapshot.Type;
type SessionRow = typeof SessionRow.Type;
type ReplyRow = typeof ReplyRow.Type;

const CheckpointEvidence = Schema.Struct({
  version: Schema.Literal(1),
  cursor: Counter,
  query: Schema.Struct({
    userId: Uuid,
    vaultId: Uuid,
    question: Schema.String,
    mode: Schema.Literals(["query", "btw"]),
    messages: Schema.Array(LlmMessageSchema),
    turnStart: Counter,
    systemPromptHash: FileFingerprint,
    models: Schema.NonEmptyArray(Schema.NonEmptyString),
    selectedModel: Schema.NullOr(Schema.NonEmptyString),
  }),
  accumulator: Schema.Struct({ answer: Schema.String, sources: Schema.Array(ReplySource) }),
});
const decodeCheckpoint = Schema.decodeUnknownResult(CheckpointEvidence);
const decodeEvent = Schema.decodeUnknownResult(StoredSessionEvent, { onExcessProperty: "error" });
const decodeRequest = Schema.decodeUnknownResult(
  Schema.Struct({ ...LegacyRequest.fields, mode: Schema.Literals(["query", "btw"]) }),
  { onExcessProperty: "error" },
);
const encodeAdmission = Schema.encodeSync(AcceptedReplyRequest, { onExcessProperty: "error" });
const timestamp = Schema.decodeUnknownSync(HistoryTimestamp);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const failureMessage = "Something went wrong while answering. Try again in a minute.";

export class ConversionBlocked extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
function block(code: string): never {
  throw new ConversionBlocked(code);
}
const address = (vaultId: Uuid, sessionId: SessionId) => `${vaultId}/${sessionId}`;
export const isConversationObject = (key: string) =>
  /^vaults\/[^/]+\/(sessions\/[^/]+\.jsonl|operations\/replies\/[^/]+\.json)$/.test(key);
export const historyKey = (vaultId: Uuid, sessionId: SessionId) =>
  `vaults/${vaultId}/sessions/${sessionId}.jsonl`;
const checkpointKey = (row: ReplyRow) => `vaults/${row.vault_id}/operations/replies/${row.id}.json`;
const retainedSources = (sources: readonly (typeof ReplySource.Type)[]) =>
  sources
    .filter((source) => source.pending !== true)
    .map(({ pending: _pending, ...source }) => source);

export type ConversionNote = {
  readonly key: string;
  readonly code: string;
  readonly line?: number;
};
export type ConversionPlan = ReturnType<typeof convertConversationSnapshot>;

export const convertConversationSnapshot = (
  snapshot: ConversationSnapshot,
  files: ReadonlyMap<string, Uint8Array>,
) => {
  const errors: ConversionNote[] = [];
  const warnings: ConversionNote[] = [];
  const objects = new Map(snapshot.objects.map((object) => [object.key, object]));
  const registry = new Map(snapshot.sessions.map((row) => [address(row.vault_id, row.id), row]));
  const rows = new Map(snapshot.replies.map((row) => [row.id, row]));
  if (
    objects.size !== snapshot.objects.length ||
    registry.size !== snapshot.sessions.length ||
    rows.size !== snapshot.replies.length ||
    new Set(snapshot.controls.map((control) => control.table)).size !== snapshot.controls.length
  )
    block("duplicate_inventory_identity");
  for (const object of snapshot.objects) {
    if (isConversationObject(object.key) && !files.has(object.key))
      block("missing_snapshot_object");
  }
  for (const [key, bytes] of files) {
    if (objects.get(key)?.sha256 !== rawFileHash(bytes)) block("source_hash_mismatch");
  }
  const histories = new Map<string, ConversationHistory>();
  const drafts = new Map<string, { row: SessionRow; writes: HistoryWrite[] }>();
  const seenReplies = new Map<Uuid, string>();
  const attempts = new Map<Uuid, HistoryAttemptWrite>();
  const terminals = new Map<Uuid, HistorySettlementWrite>();
  const recorded = new Map<
    Uuid,
    Pick<ReplyNode, "question" | "answer" | "sources"> & { messages: ReplyNode["messages"] | null }
  >();
  const note = (key: string, code: string, line?: number) =>
    warnings.push({ key, code, ...(line === undefined ? {} : { line }) });
  const utf8 = (bytes: Uint8Array) => {
    try {
      return decoder.decode(bytes);
    } catch {
      return block("invalid_utf8");
    }
  };
  const json = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return block("invalid_json");
    }
  };

  for (const row of snapshot.sessions) {
    const key = historyKey(row.vault_id, row.id);
    try {
      const bytes = files.get(key);
      if (bytes === undefined) block("missing_history");
      const text = utf8(bytes);
      if (!text.endsWith("\n")) block("missing_newline");
      const events = text
        .slice(0, -1)
        .split("\n")
        .map((line) => {
          const decoded = decodeEvent(json(line));
          if (Result.isFailure(decoded)) block("unsupported_or_invalid_record");
          return decoded.success;
        });
      const meta = events[0];
      if (meta?.type !== "meta" || events.slice(1).some((event) => event.type === "meta"))
        block("invalid_header");
      if (
        meta.id !== row.id ||
        meta.user_id !== row.user_id ||
        meta.query !== row.query ||
        !isDeepStrictEqual(meta.origin, row.origin)
      )
        block("registry_header_disagreement");
      if (row.kind === "btw" && row.origin?.anchor == null) block("inline_origin_missing");
      const header: HistoryHeaderWrite = {
        type: "conversation",
        format: "great-minds/conversation",
        version: 1,
        session_id: row.id,
        author_id: row.user_id,
        created_at: timestamp(meta.ts.toISOString()),
        origin: meta.origin,
        context: meta.context ?? null,
        anchor_reply_id: null,
      };
      const writes: HistoryWrite[] = [header];
      const byReply = new Map<
        Uuid,
        { first: ReplyNode; pending: boolean; terminal: ReplyNode | null }
      >();
      const selected = new Map<Uuid, Uuid>();
      const duplicates = new Map<string, ReplyNode>();
      for (const [index, event] of events.entries()) {
        if (event.type !== "reply") continue;
        const identity = `${event.reply_id}/${event.status === "pending" ? "pending" : "terminal"}`;
        const duplicate = duplicates.get(identity);
        if (duplicate !== undefined) {
          if (!isDeepStrictEqual(duplicate, event)) block("conflicting_record");
          note(key, "identical_record_deduplicated", index + 1);
          continue;
        }
        duplicates.set(identity, event);
        const existing = byReply.get(event.reply_id);
        if (existing === undefined) {
          if (seenReplies.has(event.reply_id)) block("reply_in_multiple_histories");
          seenReplies.set(event.reply_id, key);
          const attempt: HistoryAttemptWrite = {
            type: "attempt",
            reply_id: event.reply_id,
            exchange_id: event.exchange_id,
            previous_attempt_id: selected.get(event.exchange_id) ?? null,
            parent_reply_id: event.parent_reply_id,
            question: event.question,
            accepted_at: event.status === "pending" ? timestamp(event.ts.toISOString()) : null,
          };
          selected.set(event.exchange_id, event.reply_id);
          attempts.set(event.reply_id, attempt);
          writes.push(attempt);
          byReply.set(event.reply_id, {
            first: event,
            pending: event.status === "pending",
            terminal: null,
          });
          if (event.status !== "pending") note(key, "acceptance_time_unknown", index + 1);
        } else if (
          event.status === "pending" ||
          event.exchange_id !== existing.first.exchange_id ||
          event.question !== existing.first.question ||
          event.parent_reply_id !== existing.first.parent_reply_id
        ) {
          block("attempt_identity_disagreement");
        }
        if (event.status === "pending") {
          if (event.answer !== "" || event.messages.length !== 0 || event.sources.length !== 0)
            block("pending_record_contains_content");
          continue;
        }
        byReply.get(event.reply_id)!.terminal = event;
        const database = rows.get(event.reply_id);
        if (
          database !== undefined &&
          database.status !== "running" &&
          (database.status !== event.status ||
            database.answer !== event.answer ||
            !isDeepStrictEqual(retainedSources(database.sources), event.sources))
        )
          block("terminal_database_disagreement");
        let generation: GenerationMetadata | null = null;
        const checkpoint = database === undefined ? undefined : files.get(checkpointKey(database));
        if (checkpoint !== undefined && database !== undefined) {
          const decoded = decodeCheckpoint(json(utf8(checkpoint)));
          if (Result.isSuccess(decoded)) {
            const evidence = decoded.success;
            const prepared = evidence.query;
            const system = prepared.messages[0];
            if (
              prepared.userId === row.user_id &&
              prepared.vaultId === row.vault_id &&
              evidence.cursor === database.generation_cursor &&
              prepared.turnStart > 0 &&
              prepared.turnStart < prepared.messages.length &&
              prepared.messages[prepared.turnStart]?.role === "user" &&
              prepared.messages[prepared.turnStart]?.content === prepared.question &&
              isDeepStrictEqual(prepared.messages.slice(prepared.turnStart), event.messages) &&
              evidence.accumulator.answer === event.answer &&
              isDeepStrictEqual(retainedSources(evidence.accumulator.sources), event.sources) &&
              system?.role === "system" &&
              typeof system.content === "string" &&
              promptContentHash(system.content) === prepared.systemPromptHash
            ) {
              generation = {
                mode: prepared.mode,
                system_prompt_hash: { scheme: "gm-prompt-v1", value: prepared.systemPromptHash },
                requested_model: prepared.models[0],
                ...(prepared.selectedModel === null ? {} : { last_model: prepared.selectedModel }),
              };
              note(checkpointKey(database), "checkpoint_provenance_verified");
            }
          }
          if (generation === null)
            note(checkpointKey(database), "checkpoint_provenance_unverified");
        }
        const settled: HistorySettlementWrite = {
          type: "settlement",
          reply_id: event.reply_id,
          settled_at: timestamp(event.ts.toISOString()),
          outcome: { status: event.status },
          answer: event.answer,
          sources: event.sources,
          context_messages: event.messages,
          generation,
        };
        terminals.set(event.reply_id, settled);
        recorded.set(event.reply_id, event);
        writes.push(settled);
        if (generation === null) note(key, "generation_provenance_unknown", index + 1);
      }
      for (const [replyId, item] of byReply) {
        if (
          !item.pending &&
          (attempts.get(replyId)!.previous_attempt_id !== null ||
            selected.get(item.first.exchange_id) !== replyId)
        )
          block("ambiguous_attempt_order");
        if (item.terminal !== null) continue;
        const database = rows.get(replyId);
        if (database?.status !== "failed") block("unresolved_operation");
        const settled: HistorySettlementWrite = {
          type: "settlement",
          reply_id: replyId,
          settled_at: null,
          outcome: { status: "failed", code: "generation_failed", message: failureMessage },
          answer: database.answer,
          sources: retainedSources(database.sources),
          context_messages: null,
          generation: null,
        };
        terminals.set(replyId, settled);
        recorded.set(replyId, {
          question: item.first.question,
          answer: database.answer,
          sources: retainedSources(database.sources),
          messages: null,
        });
        writes.push(settled);
        note(key, "failure_from_committed_database");
        if (database.sources.some((source) => source.pending === true))
          note(key, "pending_sources_excluded");
      }
      drafts.set(address(row.vault_id, row.id), { row, writes });
    } catch (error) {
      if (!(error instanceof ConversionBlocked)) throw error;
      errors.push({ key, code: error.code });
    }
  }

  for (const { row, writes } of drafts.values()) {
    const key = historyKey(row.vault_id, row.id);
    try {
      const header = writes[0];
      if (header?.type !== "conversation") block("invalid_header");
      if (header.origin?.kind === "answer") {
        const origin = header.origin;
        const parent = drafts.get(address(row.vault_id, origin.session_id));
        if (parent === undefined || parent.row.user_id !== row.user_id)
          block("origin_missing_or_cross_owner");
        const candidates = parent.writes.filter(
          (record) =>
            record.type === "attempt" &&
            record.exchange_id === origin.exchange_id &&
            terminals.get(record.reply_id)?.outcome.status !== "failed" &&
            terminals.has(record.reply_id),
        );
        if (candidates.length !== 1 || candidates[0]?.type !== "attempt")
          block("ambiguous_anchor_reply");
        writes[0] = { ...header, anchor_reply_id: candidates[0].reply_id };
      }
      if (header.context !== null) {
        const parent = registry.get(address(row.vault_id, header.context.session_id));
        if (parent === undefined || parent.user_id !== row.user_id)
          block("context_missing_or_cross_owner");
      }
      const result = planHistoryAppend(row.id, null, writes);
      if (Result.isFailure(result))
        block(
          `native_${result.failure._tag === "HistoryInvalid" ? result.failure.reason : "conflict"}`,
        );
      histories.set(address(row.vault_id, row.id), result.success.history);
    } catch (error) {
      if (!(error instanceof ConversionBlocked)) throw error;
      errors.push({ key, code: error.code });
    }
  }
  for (const vaultId of new Set(snapshot.sessions.map((row) => row.vault_id))) {
    const group = snapshot.sessions
      .filter((row) => row.vault_id === vaultId)
      .flatMap((row) => {
        const history = histories.get(address(vaultId, row.id));
        return history === undefined ? [] : [history];
      });
    for (const issue of inspectHistoryDependencies(group))
      errors.push({ key: historyKey(vaultId, issue.session_id), code: issue.reason });
  }
  for (const object of snapshot.objects) {
    if (
      /^vaults\/[^/]+\/sessions\/[^/]+\.jsonl$/.test(object.key) &&
      !snapshot.sessions.some((row) => historyKey(row.vault_id, row.id) === object.key)
    )
      errors.push({ key: object.key, code: "unregistered_history" });
    if (
      /^vaults\/[^/]+\/operations\/replies\/[^/]+\.json$/.test(object.key) &&
      !snapshot.replies.some((row) => checkpointKey(row) === object.key)
    )
      warnings.push({ key: object.key, code: "unassociated_checkpoint_preserved" });
  }
  const sessionPatches = snapshot.sessions.flatMap((row) => {
    const history = histories.get(address(row.vault_id, row.id));
    if (history === undefined) return [];
    const { kind, ...fields } = row;
    const before = {
      ...fields,
      placement: kind === "btw" ? "inline" : "standalone",
      reply_mode: kind === "btw" ? "btw" : "query",
      revision: 0,
      history_seq: null,
      history_sha256: null,
    };
    return [
      {
        before,
        after: {
          ...before,
          history_seq: history.revision.last_seq,
          history_sha256: history.revision.sha256,
        },
      },
    ];
  });
  const replyPatches = snapshot.replies.flatMap((row) => {
    const key = checkpointKey(row);
    try {
      const session = registry.get(address(row.vault_id, row.session_id));
      const attempt = attempts.get(row.id);
      const terminal = terminals.get(row.id);
      if (
        session === undefined ||
        session.user_id !== row.user_id ||
        attempt === undefined ||
        terminal === undefined ||
        seenReplies.get(row.id) !== historyKey(row.vault_id, row.session_id)
      )
        block("reply_association_missing");
      const decoded = decodeRequest(row.request);
      if (Result.isFailure(decoded)) block("unsupported_request");
      const { mode, ...command } = decoded.success;
      if (
        command.reply_id !== row.id ||
        command.exchange_id !== attempt.exchange_id ||
        command.question !== attempt.question ||
        (command.session.kind === "existing" && command.session.id !== row.session_id) ||
        (command.session.kind === "new" &&
          !isDeepStrictEqual(command.session.origin ?? null, session.origin))
      )
        block("request_identity_disagreement");
      if (attempt.accepted_at === null) block("request_acceptance_time_unverified");
      const before = { ...row, settlement: null };
      const request = encodeAdmission({
        version: 1,
        command,
        mode,
        header: null,
        attempt: { ...attempt, accepted_at: attempt.accepted_at },
      });
      if (!isDeepStrictEqual(command, request.command)) block("request_conversion_changed_options");
      note(key, "terminal_request_intent_wrapped_not_generation_provenance");
      return [
        {
          before,
          after: {
            ...before,
            status: terminal.outcome.status,
            answer: terminal.answer,
            sources: terminal.sources,
            error: terminal.outcome.status === "failed" ? terminal.outcome.message : null,
            version: row.version + 1,
            request,
            active_generation_step: null,
            active_generation_kind: null,
            active_generation_key: null,
          },
        },
      ];
    } catch (error) {
      if (!(error instanceof ConversionBlocked)) throw error;
      errors.push({ key, code: error.code });
      return [];
    }
  });
  const converted = snapshot.sessions.flatMap((row) => {
    const history = histories.get(address(row.vault_id, row.id));
    return history === undefined ? [] : [{ key: historyKey(row.vault_id, row.id), history }];
  });
  return {
    histories: converted,
    patch: { sessions: sessionPatches, replies: replyPatches },
    report: {
      format: "great-minds/conversation-conversion" as const,
      version: 1 as const,
      database_sha256: snapshot.database_sha256,
      counts: {
        sessions: snapshot.sessions.length,
        replies: snapshot.replies.length,
        objects: snapshot.objects.length,
        converted: converted.length,
        preserved_objects: snapshot.objects.length - converted.length,
        attempts: converted.reduce(
          (sum, item) =>
            sum + item.history.turns.reduce((count, turn) => count + turn.attempts.length, 0),
          0,
        ),
        settlements: converted.reduce(
          (sum, item) =>
            sum + item.history.records.filter((record) => record.type === "settlement").length,
          0,
        ),
      },
      objects: converted.map(({ key, history }) => ({
        key,
        before: objects.get(key)!.sha256,
        after: history.revision.sha256,
        attempts: history.turns.flatMap((turn) =>
          turn.attempts.map((item) => {
            const source = recorded.get(item.accepted.reply_id)!;
            const contentEqual = {
              question: item.accepted.question === source.question,
              answer: item.settlement?.answer === source.answer,
              sources: isDeepStrictEqual(item.settlement?.sources, source.sources),
              context_messages: isDeepStrictEqual(
                item.settlement?.context_messages,
                source.messages,
              ),
            };
            if (Object.values(contentEqual).some((equal) => !equal))
              errors.push({ key, code: "converted_content_changed" });
            return {
              reply_id: item.accepted.reply_id,
              exchange_id: item.accepted.exchange_id,
              previous_attempt_id: item.accepted.previous_attempt_id,
              parent_reply_id: item.accepted.parent_reply_id,
              outcome: item.settlement?.outcome.status ?? "pending",
              content_equal: contentEqual,
              retained_messages_known: source.messages !== null,
            };
          }),
        ),
      })),
      errors,
      warnings,
    },
  };
};
