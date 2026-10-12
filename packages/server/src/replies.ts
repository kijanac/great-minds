import { Database, replies, vaults } from "@great-minds/database";
import {
  BadRequest,
  type CreateReplyRequest,
  type CreateReplyResponse,
  Conflict,
  Forbidden,
  NotFound,
  isReplyPending,
  type QueryRequest,
  type QuerySourceData,
  ReplySnapshot as ReplySnapshotSchema,
  type ReplySource,
  ReplySource as ReplySourceSchema,
  type ReplySseEvent,
  ServiceUnavailable,
  Uuid,
} from "@great-minds/domain";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Option, Schema, SchemaGetter, Stream } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";

import { backgroundLoop } from "./background-loop.ts";
import { AppConfig } from "./config.ts";
import {
  acceptedRequestFor,
  ReplyAdmission,
  type ReplyAdmissionError,
} from "./conversation-history/admission.ts";
import { replySnapshot } from "./conversation-history/presentation.ts";
import type { GenerationMetadata } from "./conversation-history/schema.ts";
import { ReplySettlement, type ReplySettlementResult } from "./conversation-history/settlement.ts";
import type { LlmMessage } from "./llm.ts";
import { StructuredLogger } from "./logging.ts";
import { pollingSse } from "./polling-sse.ts";
import {
  QueryExecutionState,
  type QueryPrecheckedContext,
  type QueryPreparedToolCall as QueryPreparedToolCallType,
  QueryPreparedToolCall,
  QueryService,
} from "./query.ts";
import { SessionsService } from "./sessions.ts";
import { ContentStorage, vaultOwner } from "./storage.ts";
import { VaultAccessService } from "./vaults.ts";

const terminalStatuses = new Set(["completed", "failed", "stopped"]);
const sanitizedReplyError = "Something went wrong while answering. Try again in a minute.";
const ambiguousReplyError =
  "Reply interrupted before an external response could be saved. It was not retried automatically.";
const flushIntervalMs = 125;
const encodeReplySnapshot = Schema.encodeSync(Schema.fromJsonString(ReplySnapshotSchema));

type ReplyRow = typeof replies.$inferSelect;
type ReplyRequestError = BadRequest | Conflict | Forbidden | NotFound | ServiceUnavailable;

const ReplyStepControl = Schema.Struct({
  cursor: Schema.Number,
  outcome: Schema.Literals(["ready", "retryable", "tool_calls", "done", "failed", "stopped"]),
  error: Schema.NullOr(Schema.String),
});
type ReplyStepControl = typeof ReplyStepControl.Type;

const ReplyAccumulator = Schema.Struct({
  answer: Schema.mutableKey(Schema.String),
  sources: Schema.mutable(Schema.Array(ReplySourceSchema)),
  pendingCalls: Schema.Array(
    Schema.Struct({ callId: Schema.String, index: Schema.NullOr(Schema.Number) }),
  ).pipe(
    Schema.decodeTo(Schema.instanceOf(Map<string, number | null>), {
      decode: SchemaGetter.transform(
        (entries) => new Map(entries.map(({ callId, index }) => [callId, index])),
      ),
      encode: SchemaGetter.transform((entries) =>
        [...entries].map(([callId, index]) => ({ callId, index })),
      ),
    }),
  ),
  clearOnNextToken: Schema.mutableKey(Schema.Boolean),
});
type ReplyAccumulator = typeof ReplyAccumulator.Type;

const ReplyCheckpoint = Schema.Struct({
  version: Schema.Literal(1),
  cursor: Schema.Number,
  query: QueryExecutionState,
  accumulator: ReplyAccumulator,
  pendingTools: Schema.Array(QueryPreparedToolCall),
  nextToolIndex: Schema.Number,
  lastControl: ReplyStepControl,
});
type ReplyCheckpoint = typeof ReplyCheckpoint.Type;

const decodeReplyCheckpoint = Schema.decodeUnknownSync(Schema.fromJsonString(ReplyCheckpoint));
const encodeReplyCheckpoint = Schema.encodeSync(Schema.fromJsonString(ReplyCheckpoint));
const checkpointPath = (replyId: Uuid) => `operations/replies/${replyId}.json`;
const isInterruption = (cause: Cause.Cause<unknown>) =>
  cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason);
const terminalControl = (control: ReplyStepControl) =>
  control.outcome === "done" || control.outcome === "failed" || control.outcome === "stopped";
const readyControl = (cursor: number): ReplyStepControl => ({
  cursor,
  outcome: "ready",
  error: null,
});
const failedControl = (cursor: number, error: string): ReplyStepControl => ({
  cursor,
  outcome: "failed",
  error,
});
const doneControl = (cursor: number): ReplyStepControl => ({
  cursor,
  outcome: "done",
  error: null,
});
const stoppedControl = (cursor: number): ReplyStepControl => ({
  cursor,
  outcome: "stopped",
  error: null,
});

const queryRequest = (
  input: CreateReplyRequest,
  question: string,
  mode: QueryRequest["mode"],
): QueryRequest => ({
  question,
  mode,
  ...(input.model === undefined ? {} : { model: input.model }),
  ...(input.origin_path === undefined ? {} : { origin_path: input.origin_path }),
  origin_scope: input.origin_scope,
  ...(input.extra_instructions === undefined
    ? {}
    : { extra_instructions: input.extra_instructions }),
});

const sourceRef = (data: QuerySourceData, thinking: string, pending = false): ReplySource => {
  const source: ReplySource = {
    label:
      data.type === "search"
        ? data.query
        : data.type === "query"
          ? Object.entries(data.filters)
              .map(([key, value]) => `${key}: ${String(value)}`)
              .join(", ") || "filtered sources"
          : data.path,
    type: data.type,
    document_id: data.type === "article" || data.type === "raw" ? data.document_id : null,
    title: data.type === "query" ? null : data.title,
    scope: data.type === "search" ? data.scope : null,
    path: data.type === "search" ? (data.path ?? null) : null,
    thinking: thinking.length === 0 ? null : thinking,
    ...(pending ? { pending: true } : {}),
  };
  if (data.type === "article" || data.type === "raw") {
    const isExpand = data.start !== undefined && data.end !== undefined;
    return {
      ...source,
      ranges: isExpand ? [{ start: data.start, end: data.end }] : [],
      full: !isExpand,
    };
  }
  return source;
};

const requestError = (error: ReplyAdmissionError): ReplyRequestError => {
  switch (error._tag) {
    case "BadRequest":
    case "Conflict":
    case "Forbidden":
    case "NotFound":
    case "ServiceUnavailable":
      return error;
    case "ObjectVersionConflict":
      return new Conflict({
        detail: "Conversation changed while accepting the reply; submit the same request again",
      });
    case "HistoryConflict":
      return new Conflict({ detail: "Conversation history requires reconciliation" });
    default:
      return new ServiceUnavailable({
        detail:
          "Reply admission is unfinished; retry the same request rather than starting another reply",
      });
  }
};

export const ReplyWorkflow = Workflow.make("ReplyGeneration", {
  payload: { replyId: Uuid },
  idempotencyKey: ({ replyId }) => replyId,
  success: Schema.Void,
});

const dispatchReply = (replyId: Uuid, workflowEngine: WorkflowEngine.WorkflowEngine["Service"]) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const rows = yield* db.query((d) =>
      d.select({ status: replies.status }).from(replies).where(eq(replies.id, replyId)),
    );
    if (rows[0]?.status !== "running") return;
    yield* ReplyWorkflow.execute({ replyId }, { discard: true }).pipe(
      Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine),
    );
    yield* db.query((d) =>
      d
        .update(replies)
        .set({
          dispatchedAt: sql`coalesce(${replies.dispatchedAt}, now())`,
          dispatchedTaskId: replyId,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(replies.id, replyId), eq(replies.status, "running"), isNull(replies.dispatchedAt)),
        ),
    );
  });

type RepliesServiceShape = {
  readonly stop: (
    userId: Uuid,
    vaultId: Uuid,
    replyId: Uuid,
  ) => Effect.Effect<void, Forbidden | NotFound>;
  readonly create: (
    userId: Uuid,
    vaultId: Uuid,
    input: CreateReplyRequest,
  ) => Effect.Effect<CreateReplyResponse, ReplyRequestError>;
  readonly retry: (
    userId: Uuid,
    vaultId: Uuid,
    replyId: Uuid,
    nextReplyId: Uuid,
  ) => Effect.Effect<CreateReplyResponse, ReplyRequestError>;
  readonly stream: (
    userId: Uuid,
    vaultId: Uuid,
    replyId: Uuid,
  ) => Effect.Effect<Stream.Stream<ReplySseEvent>, Forbidden | NotFound>;
  readonly prepareStep: (replyId: Uuid) => Effect.Effect<ReplyStepControl>;
  readonly modelStep: (replyId: Uuid, cursor: number) => Effect.Effect<ReplyStepControl>;
  readonly toolStep: (replyId: Uuid, cursor: number) => Effect.Effect<ReplyStepControl>;
  readonly finalizeStep: (
    replyId: Uuid,
    outcome: "done" | "failed" | "stopped",
    error: string | null,
  ) => Effect.Effect<void>;
  readonly reconcileOnce: () => Effect.Effect<number>;
};

export class RepliesService extends Context.Service<RepliesService, RepliesServiceShape>()(
  "@great-minds/server/RepliesService",
) {}

export const RepliesServiceLive = Layer.effect(
  RepliesService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;
    const config = yield* AppConfig;
    const logger = yield* StructuredLogger;
    const query = yield* QueryService;
    const sessions = yield* SessionsService;
    const admission = yield* ReplyAdmission;
    const settlement = yield* ReplySettlement;
    const storage = yield* ContentStorage;
    const workflowEngine = yield* WorkflowEngine.WorkflowEngine;
    const pollIntervalMs = Option.isSome(config.goldensClock) ? 1 : 100;

    const readReply = (vaultId: Uuid, replyId: Uuid) =>
      db
        .query((d) =>
          d
            .select()
            .from(replies)
            .where(and(eq(replies.id, replyId), eq(replies.vaultId, vaultId)))
            .limit(1),
        )
        .pipe(Effect.map((rows) => rows[0]));
    const readReplyById = (replyId: Uuid) =>
      db
        .query((d) => d.select().from(replies).where(eq(replies.id, replyId)).limit(1))
        .pipe(Effect.map((rows) => rows[0]));

    const readGenerationReply = (replyId: Uuid) =>
      Effect.gen(function* () {
        yield* settlement.restoreRecorded(replyId).pipe(Effect.orDie);
        return yield* readReplyById(replyId);
      });

    const updateSnapshot = (replyId: Uuid, answer: string, sources: readonly ReplySource[]) =>
      db
        .query((d) =>
          d
            .update(replies)
            .set({ answer, sources, version: sql`${replies.version} + 1`, updatedAt: sql`now()` })
            .where(and(eq(replies.id, replyId), eq(replies.status, "running"))),
        )
        .pipe(Effect.asVoid);

    const untilStopped = <A, E>(replyId: Uuid, work: Effect.Effect<A, E>) =>
      Effect.raceFirst(
        work.pipe(Effect.map(Option.some)),
        Effect.gen(function* () {
          while (true) {
            const row = yield* readReplyById(replyId);
            if (row === undefined || row.status !== "running" || row.stopRequested)
              return Option.none<A>();
            yield* Effect.sleep("100 millis");
          }
        }),
      );

    const readCheckpoint = (row: ReplyRow) =>
      storage.readText(vaultOwner(row.vaultId), checkpointPath(row.id)).pipe(
        Effect.map(decodeReplyCheckpoint),
        Effect.catchTag("StorageFileMissing", () => Effect.succeed(undefined)),
      );
    const writeCheckpoint = (row: ReplyRow, checkpoint: ReplyCheckpoint) =>
      storage.writeText(
        vaultOwner(row.vaultId),
        checkpointPath(row.id),
        encodeReplyCheckpoint(checkpoint),
      );
    const recoverCheckpoint = (row: ReplyRow) =>
      readCheckpoint(row).pipe(
        Effect.catchCause((cause) =>
          isInterruption(cause)
            ? Effect.interrupt
            : logger
                .warn("reply_checkpoint_unavailable", { reply_id: row.id })
                .pipe(Effect.as(undefined)),
        ),
      );

    const removeSource = (accumulator: ReplyAccumulator, index: number) => {
      accumulator.sources.splice(index, 1);
      for (const [callId, pendingIndex] of accumulator.pendingCalls) {
        if (pendingIndex !== null && pendingIndex > index)
          accumulator.pendingCalls.set(callId, pendingIndex - 1);
      }
    };

    const addPendingSource = (
      accumulator: ReplyAccumulator,
      callId: string,
      data: QuerySourceData,
    ) => {
      if (
        (data.type === "article" || data.type === "raw") &&
        accumulator.sources.some(
          (source) =>
            source.label === data.path && (source.type === "article" || source.type === "raw"),
        )
      ) {
        accumulator.pendingCalls.set(callId, null);
      } else {
        accumulator.pendingCalls.set(callId, accumulator.sources.length);
        accumulator.sources.push(sourceRef(data, accumulator.answer, true));
        accumulator.clearOnNextToken = true;
      }
    };

    const addResolvedSource = (
      accumulator: ReplyAccumulator,
      data: QuerySourceData,
      pendingIndex: number | null,
    ) => {
      if (data.type === "article" || data.type === "raw") {
        if (pendingIndex !== null) removeSource(accumulator, pendingIndex);
        const isExpand = data.start !== undefined && data.end !== undefined;
        const range = isExpand ? { start: data.start, end: data.end } : null;
        const index = accumulator.sources.findIndex(
          (source) =>
            source.label === data.path && (source.type === "article" || source.type === "raw"),
        );
        if (index >= 0) {
          const previous = accumulator.sources[index];
          accumulator.sources[index] = {
            ...previous,
            ranges: range ? [...(previous.ranges ?? []), range] : previous.ranges,
            full: previous.full || !isExpand,
          };
        } else accumulator.sources.push(sourceRef(data, accumulator.answer));
        accumulator.clearOnNextToken = true;
        return;
      }
      if (data.type === "links") {
        const existingIndex = accumulator.sources.findIndex(
          (source, index) =>
            index !== pendingIndex && source.type === "links" && source.label === data.path,
        );
        if (existingIndex >= 0) {
          if (pendingIndex !== null) removeSource(accumulator, pendingIndex);
          return;
        }
      }
      const resolved = sourceRef(data, accumulator.answer);
      if (pendingIndex === null) accumulator.sources.push(resolved);
      else accumulator.sources.splice(pendingIndex, 1, resolved);
      accumulator.clearOnNextToken = true;
    };

    const flushAccumulator = (replyId: Uuid, accumulator: ReplyAccumulator) =>
      updateSnapshot(replyId, accumulator.answer, accumulator.sources);

    const freezeOutcome = (
      row: ReplyRow,
      checkpoint: ReplyCheckpoint | undefined,
      outcome: "done" | "failed" | "stopped",
      error: string | null,
    ) =>
      Effect.gen(function* () {
        const generation: GenerationMetadata | null =
          checkpoint === undefined
            ? null
            : {
                mode: checkpoint.query.mode,
                system_prompt_hash: {
                  scheme: "gm-prompt-v1",
                  value: checkpoint.query.systemPromptHash,
                },
                requested_model: checkpoint.query.models[0],
                ...(checkpoint.query.selectedModel === null
                  ? {}
                  : { last_model: checkpoint.query.selectedModel }),
              };
        const messages: readonly LlmMessage[] | null =
          checkpoint === undefined
            ? yield* sessions
                .readReplyQuestion(row.userId, row.vaultId, row.sessionId, row.id)
                .pipe(
                  Effect.map((question) => [{ role: "user" as const, content: question }]),
                  Effect.catchTag("Forbidden", () => Effect.succeed(null)),
                )
            : checkpoint.query.messages.slice(checkpoint.query.turnStart);
        let result: ReplySettlementResult;
        if (row.stopRequested || outcome === "stopped") {
          result = { status: "stopped", context_messages: messages, generation };
        } else if (outcome === "failed") {
          result = {
            status: "failed",
            code: error === ambiguousReplyError ? "external_outcome_unknown" : "generation_failed",
            message: error ?? sanitizedReplyError,
            context_messages: messages,
            generation,
          };
        } else {
          if (checkpoint === undefined || generation === null || messages === null) {
            return yield* Effect.die(
              new Error(`Reply ${row.id} finished without its generation result`),
            );
          }
          result = {
            status: "completed",
            answer: checkpoint.accumulator.answer,
            sources: checkpoint.accumulator.sources
              .filter((source) => source.pending !== true)
              .map(({ pending: _pending, ...source }) => source),
            context_messages: messages,
            generation,
          };
        }
        yield* settlement.begin(row.id, result);
      }).pipe(Effect.orDie);

    const freezeStopped = (row: ReplyRow) =>
      Effect.gen(function* () {
        yield* freezeOutcome(row, yield* recoverCheckpoint(row), "stopped", null);
        return stoppedControl(row.generationCursor);
      });

    const stepFailure = (replyId: Uuid, cursor: number, cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        if (isInterruption(cause)) return yield* Effect.interrupt;
        yield* logger.error("reply_generation_step_failed", {
          reply_id: replyId,
          generation_cursor: cursor,
        });
        const row = yield* readGenerationReply(replyId);
        if (row === undefined || row.status !== "running") return doneControl(cursor);
        const checkpoint = yield* recoverCheckpoint(row);
        const control = checkpoint?.lastControl;
        if (
          control !== undefined &&
          (control.outcome === "done" ||
            control.outcome === "failed" ||
            control.outcome === "stopped")
        ) {
          yield* freezeOutcome(row, checkpoint, control.outcome, control.error);
          return control;
        }
        const error = row.activeGenerationStep === null ? sanitizedReplyError : ambiguousReplyError;
        yield* freezeOutcome(row, checkpoint, "failed", error);
        return failedControl(cursor, error);
      });

    const recoverCompletedStep = (
      row: ReplyRow,
      checkpoint: ReplyCheckpoint,
      expectedCursor: number,
    ) =>
      Effect.gen(function* () {
        if (checkpoint.cursor <= expectedCursor) return undefined;
        yield* db.query((d) =>
          d
            .update(replies)
            .set({
              generationCursor: checkpoint.cursor,
              activeGenerationStep: null,
              activeGenerationKind: null,
              activeGenerationKey: null,
              updatedAt: sql`now()`,
            })
            .where(and(eq(replies.id, row.id), eq(replies.status, "running"))),
        );
        return checkpoint.lastControl;
      });

    const claimExternalStep = (
      row: ReplyRow,
      checkpoint: ReplyCheckpoint,
      expectedCursor: number,
      kind: "model" | "tool",
      key: string,
    ) =>
      Effect.gen(function* () {
        const recovered = yield* recoverCompletedStep(row, checkpoint, expectedCursor);
        if (recovered !== undefined) return recovered;
        if (checkpoint.cursor !== expectedCursor || row.generationCursor !== expectedCursor) {
          throw new Error(
            `Reply ${row.id} cursor mismatch: workflow=${expectedCursor}, database=${row.generationCursor}, checkpoint=${checkpoint.cursor}`,
          );
        }
        if (row.activeGenerationStep !== null)
          return failedControl(expectedCursor, ambiguousReplyError);
        const claimed = yield* db.query((d) =>
          d
            .update(replies)
            .set({
              activeGenerationStep: expectedCursor,
              activeGenerationKind: kind,
              activeGenerationKey: key,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(replies.id, row.id),
                eq(replies.status, "running"),
                eq(replies.stopRequested, false),
                eq(replies.generationCursor, expectedCursor),
                isNull(replies.activeGenerationStep),
              ),
            )
            .returning({ id: replies.id }),
        );
        if (claimed.length !== 1) {
          const current = yield* readReplyById(row.id);
          if (current === undefined || current.status !== "running")
            return doneControl(expectedCursor);
          if (current.stopRequested) return stoppedControl(expectedCursor);
          throw new Error(`Reply ${row.id} generation step ${expectedCursor} was not claimable`);
        }
        return undefined;
      });

    const commitExternalStep = (row: ReplyRow, checkpoint: ReplyCheckpoint) =>
      Effect.gen(function* () {
        yield* writeCheckpoint(row, checkpoint);
        yield* db.query((d) =>
          d
            .update(replies)
            .set({
              generationCursor: checkpoint.cursor,
              activeGenerationStep: null,
              activeGenerationKind: null,
              activeGenerationKey: null,
              updatedAt: sql`now()`,
            })
            .where(and(eq(replies.id, row.id), eq(replies.status, "running"))),
        );
      });

    const freezeControl = (row: ReplyRow, checkpoint: ReplyCheckpoint, control: ReplyStepControl) =>
      Effect.gen(function* () {
        if (
          control.outcome === "done" ||
          control.outcome === "failed" ||
          control.outcome === "stopped"
        ) {
          yield* freezeOutcome(row, checkpoint, control.outcome, control.error);
        }
        return control;
      });

    const prepareStep = (replyId: Uuid) =>
      Effect.gen(function* () {
        const row = yield* readGenerationReply(replyId);
        if (row === undefined) return doneControl(0);
        if (row.status !== "running") return doneControl(row.generationCursor);
        if (row.stopRequested) return yield* freezeStopped(row);
        const existing = yield* readCheckpoint(row);
        if (existing !== undefined)
          return yield* freezeControl(row, existing, existing.lastControl);
        const accepted = yield* acceptedRequestFor(row);
        const transcript = yield* sessions.readTranscript(
          row.userId,
          row.vaultId,
          row.sessionId,
          row.id,
        );
        const vaultRows = yield* db.query((d) =>
          d.select({ name: vaults.name }).from(vaults).where(eq(vaults.id, row.vaultId)).limit(1),
        );
        const vault = vaultRows[0];
        if (vault === undefined) throw new Error(`Reply ${row.id} has no vault`);
        const prechecked: QueryPrecheckedContext = { vaultLabel: vault.name };
        const queryState = yield* query.prepareExecution(
          row.userId,
          row.vaultId,
          queryRequest(accepted.command, transcript.question, accepted.mode),
          prechecked,
          transcript.prior,
        );
        const control = readyControl(row.generationCursor);
        const checkpoint: ReplyCheckpoint = {
          version: 1,
          cursor: row.generationCursor,
          query: queryState,
          accumulator: {
            answer: "",
            sources: [],
            pendingCalls: new Map(),
            clearOnNextToken: false,
          },
          pendingTools: [],
          nextToolIndex: 0,
          lastControl: control,
        };
        yield* updateSnapshot(replyId, "", []);
        yield* writeCheckpoint(row, checkpoint);
        return control;
      }).pipe(Effect.catchCause((cause) => stepFailure(replyId, 0, cause)));

    const modelStep = (replyId: Uuid, expectedCursor: number) =>
      Effect.gen(function* () {
        const row = yield* readGenerationReply(replyId);
        if (row === undefined) return doneControl(expectedCursor);
        if (row.status !== "running") return doneControl(row.generationCursor);
        if (row.stopRequested) return yield* freezeStopped(row);
        const checkpoint = yield* readCheckpoint(row);
        if (checkpoint === undefined)
          throw new Error(`Reply ${replyId} has no generation checkpoint`);
        if (terminalControl(checkpoint.lastControl))
          return yield* freezeControl(row, checkpoint, checkpoint.lastControl);
        const claimed = yield* claimExternalStep(
          row,
          checkpoint,
          expectedCursor,
          "model",
          `${checkpoint.query.modelIndex}:${checkpoint.query.trace.llmRounds + 1}`,
        );
        if (claimed !== undefined) return yield* freezeControl(row, checkpoint, claimed);
        const accumulator = checkpoint.accumulator;
        let lastFlushAt = 0;
        const attempt = yield* untilStopped(
          replyId,
          query.modelAttempt(checkpoint.query, (text) =>
            Effect.gen(function* () {
              if (accumulator.clearOnNextToken) {
                accumulator.answer = "";
                accumulator.clearOnNextToken = false;
              }
              accumulator.answer += text;
              if (Date.now() - lastFlushAt >= flushIntervalMs) {
                yield* flushAccumulator(replyId, accumulator);
                lastFlushAt = Date.now();
              }
            }),
          ),
        );
        if (Option.isNone(attempt)) {
          yield* flushAccumulator(replyId, accumulator);
          yield* freezeOutcome(row, checkpoint, "stopped", null);
          return stoppedControl(expectedCursor);
        }
        const outcome = attempt.value;
        let control: ReplyStepControl;
        let pendingTools: readonly QueryPreparedToolCallType[] = [];
        if (outcome.kind === "tool_calls") {
          for (const toolCall of outcome.toolCalls) {
            if (toolCall.pendingSource !== undefined)
              addPendingSource(accumulator, toolCall.id, toolCall.pendingSource);
          }
          pendingTools = outcome.toolCalls;
          control = { cursor: expectedCursor + 1, outcome: "tool_calls", error: null };
        } else if (outcome.kind === "retryable") {
          accumulator.clearOnNextToken = true;
          control = { cursor: expectedCursor + 1, outcome: "retryable", error: null };
        } else if (outcome.kind === "done") control = doneControl(expectedCursor + 1);
        else control = failedControl(expectedCursor + 1, outcome.error);
        yield* flushAccumulator(replyId, accumulator);
        const nextCheckpoint: ReplyCheckpoint = {
          version: 1,
          cursor: expectedCursor + 1,
          query: outcome.state,
          accumulator,
          pendingTools,
          nextToolIndex: 0,
          lastControl: control,
        };
        if (control.outcome === "done" || control.outcome === "failed") {
          yield* freezeOutcome(row, nextCheckpoint, control.outcome, control.error);
          const saved = yield* writeCheckpoint(row, nextCheckpoint).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              isInterruption(cause)
                ? Effect.interrupt
                : logger
                    .warn("reply_terminal_checkpoint_unavailable", { reply_id: row.id })
                    .pipe(Effect.as(false)),
            ),
          );
          if (!saved) yield* query.finalizeExecution(nextCheckpoint.query);
        } else yield* commitExternalStep(row, nextCheckpoint);
        return control;
      }).pipe(Effect.catchCause((cause) => stepFailure(replyId, expectedCursor, cause)));

    const toolStep = (replyId: Uuid, expectedCursor: number) =>
      Effect.gen(function* () {
        const row = yield* readGenerationReply(replyId);
        if (row === undefined) return doneControl(expectedCursor);
        if (row.status !== "running") return doneControl(row.generationCursor);
        if (row.stopRequested) return yield* freezeStopped(row);
        const checkpoint = yield* readCheckpoint(row);
        if (checkpoint === undefined)
          throw new Error(`Reply ${replyId} has no generation checkpoint`);
        if (terminalControl(checkpoint.lastControl))
          return yield* freezeControl(row, checkpoint, checkpoint.lastControl);
        const toolCall = checkpoint.pendingTools[checkpoint.nextToolIndex];
        if (toolCall === undefined)
          throw new Error(`Reply ${replyId} has no pending tool at ${checkpoint.nextToolIndex}`);
        const claimed = yield* claimExternalStep(
          row,
          checkpoint,
          expectedCursor,
          "tool",
          toolCall.id,
        );
        if (claimed !== undefined) return yield* freezeControl(row, checkpoint, claimed);
        const accumulator = checkpoint.accumulator;
        const attempt = yield* untilStopped(replyId, query.runTool(checkpoint.query, toolCall));
        if (Option.isNone(attempt)) {
          yield* freezeOutcome(row, checkpoint, "stopped", null);
          return stoppedControl(expectedCursor);
        }
        const result = attempt.value;
        const pendingIndex = accumulator.pendingCalls.get(toolCall.id) ?? null;
        accumulator.pendingCalls.delete(toolCall.id);
        if (result.source !== undefined)
          addResolvedSource(accumulator, result.source, pendingIndex);
        else if (pendingIndex !== null) removeSource(accumulator, pendingIndex);
        yield* flushAccumulator(replyId, accumulator);
        const nextToolIndex = checkpoint.nextToolIndex + 1;
        const remaining = checkpoint.pendingTools.length - nextToolIndex;
        const control: ReplyStepControl =
          remaining > 0
            ? { cursor: expectedCursor + 1, outcome: "tool_calls", error: null }
            : readyControl(expectedCursor + 1);
        const nextCheckpoint: ReplyCheckpoint = {
          version: 1,
          cursor: expectedCursor + 1,
          query: result.state,
          accumulator,
          pendingTools: remaining > 0 ? checkpoint.pendingTools : [],
          nextToolIndex: remaining > 0 ? nextToolIndex : 0,
          lastControl: control,
        };
        yield* commitExternalStep(row, nextCheckpoint);
        return control;
      }).pipe(Effect.catchCause((cause) => stepFailure(replyId, expectedCursor, cause)));

    const publishBestEffort = (replyId: Uuid) =>
      settlement.publish(replyId).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          isInterruption(cause)
            ? Effect.interrupt
            : logger.warn("reply_settlement_deferred", { reply_id: replyId }),
        ),
      );

    const finalizeStep = (
      replyId: Uuid,
      outcome: "done" | "failed" | "stopped",
      error: string | null,
    ) =>
      Effect.gen(function* () {
        const row = yield* readGenerationReply(replyId);
        if (row === undefined || row.status === "admitting") return;
        if (row.status === "running")
          yield* freezeOutcome(row, yield* recoverCheckpoint(row), outcome, error);
        yield* publishBestEffort(replyId);
        const checkpoint = yield* recoverCheckpoint(row);
        if (checkpoint !== undefined) yield* query.finalizeExecution(checkpoint.query);
      }).pipe(
        Effect.catchCause((cause) =>
          isInterruption(cause)
            ? Effect.interrupt
            : logger.warn("reply_finalization_deferred", { reply_id: replyId }),
        ),
      );

    const dispatchBestEffort = (replyId: Uuid) =>
      dispatchReply(replyId, workflowEngine).pipe(
        Effect.provideService(Database, db),
        Effect.catchCause((cause) =>
          isInterruption(cause)
            ? Effect.interrupt
            : logger.warn("reply_dispatch_deferred", { reply_id: replyId }),
        ),
      );

    const acceptAndDispatch = (accept: Effect.Effect<CreateReplyResponse, ReplyAdmissionError>) =>
      Effect.gen(function* () {
        const response = yield* accept.pipe(Effect.mapError(requestError));
        yield* dispatchBestEffort(response.reply_id);
        return response;
      });

    const reconcileReply = (initial: ReplyRow) =>
      Effect.gen(function* () {
        const row = yield* readGenerationReply(initial.id);
        if (row === undefined || terminalStatuses.has(row.status)) return;
        if (row.status === "admitting") {
          yield* admission.admit(row.id);
          yield* dispatchBestEffort(row.id);
        } else if (row.status === "settling") {
          yield* publishBestEffort(row.id);
        } else if (row.dispatchedAt === null) {
          yield* dispatchBestEffort(row.id);
        } else {
          const executionId = yield* ReplyWorkflow.executionId({ replyId: row.id });
          const state = yield* ReplyWorkflow.poll(executionId).pipe(
            Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine),
          );
          if (Option.isNone(state)) {
            yield* dispatchBestEffort(row.id);
          } else if (state.value._tag === "Suspended") {
            yield* ReplyWorkflow.resume(executionId).pipe(
              Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine),
            );
          } else {
            const checkpoint = yield* recoverCheckpoint(row);
            const control = checkpoint?.lastControl;
            if (
              control !== undefined &&
              (control.outcome === "done" ||
                control.outcome === "failed" ||
                control.outcome === "stopped")
            ) {
              yield* freezeOutcome(row, checkpoint, control.outcome, control.error);
            } else {
              yield* freezeOutcome(
                row,
                checkpoint,
                "failed",
                row.activeGenerationStep === null ? sanitizedReplyError : ambiguousReplyError,
              );
            }
            yield* publishBestEffort(row.id);
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          isInterruption(cause)
            ? Effect.interrupt
            : logger.warn("reply_reconciliation_deferred", { reply_id: initial.id }),
        ),
      );

    type ReconciliationPosition = { readonly createdAt: Date; readonly id: Uuid };
    let reconciliationScan: {
      readonly after: ReconciliationPosition | null;
      readonly through: ReconciliationPosition;
    } | null = null;

    return {
      create: (userId, vaultId, input) =>
        acceptAndDispatch(admission.accept(userId, vaultId, input)),
      retry: (userId, vaultId, replyId, nextReplyId) =>
        acceptAndDispatch(admission.retry(userId, vaultId, replyId, nextReplyId)),
      stop: (userId, vaultId, replyId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const row = yield* readReply(vaultId, replyId);
          if (row === undefined || row.userId !== userId)
            return yield* new NotFound({ detail: "Reply not found" });
          yield* db.query((d) =>
            d
              .update(replies)
              .set({ stopRequested: true, updatedAt: sql`now()` })
              .where(
                and(eq(replies.id, replyId), inArray(replies.status, ["admitting", "running"])),
              ),
          );
        }),
      stream: (userId, vaultId, replyId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const initial = yield* readReply(vaultId, replyId);
          if (initial === undefined || initial.userId !== userId)
            return yield* new NotFound({ detail: "Reply not found" });
          return pollingSse(
            replyId,
            readReply(vaultId, replyId).pipe(
              Effect.map((row) => (row?.userId === userId ? row : undefined)),
            ),
            (row) => {
              const current = replySnapshot(row);
              return {
                version: row.version,
                data: encodeReplySnapshot(current),
                terminal: !isReplyPending(current.status),
              };
            },
            pollIntervalMs,
          ).pipe(
            Stream.takeWhileEffect(() =>
              access.requireMember(userId, vaultId).pipe(
                Effect.as(true),
                Effect.catchTag("Forbidden", () => Effect.succeed(false)),
              ),
            ),
          );
        }),
      prepareStep,
      modelStep,
      toolStep,
      finalizeStep,
      reconcileOnce: () =>
        Effect.gen(function* () {
          const pending = inArray(replies.status, ["admitting", "running", "settling"]);
          let scan = reconciliationScan;
          if (scan === null) {
            const [through] = yield* db.query((d) =>
              d
                .select({ createdAt: replies.createdAt, id: replies.id })
                .from(replies)
                .where(pending)
                .orderBy(desc(replies.createdAt), desc(replies.id))
                .limit(1),
            );
            if (through === undefined) return 0;
            scan = { after: null, through };
          }
          const after =
            scan.after === null
              ? undefined
              : or(
                  gt(replies.createdAt, scan.after.createdAt),
                  and(eq(replies.createdAt, scan.after.createdAt), gt(replies.id, scan.after.id)),
                );
          const through = or(
            lt(replies.createdAt, scan.through.createdAt),
            and(eq(replies.createdAt, scan.through.createdAt), lte(replies.id, scan.through.id)),
          );
          const rows = yield* db.query((d) =>
            d
              .select()
              .from(replies)
              .where(and(pending, after, through))
              .orderBy(asc(replies.createdAt), asc(replies.id))
              .limit(config.pipelineConcurrency),
          );
          const last = rows.at(-1);
          reconciliationScan =
            last === undefined || last.id === scan.through.id
              ? null
              : { after: { createdAt: last.createdAt, id: last.id }, through: scan.through };
          yield* Effect.forEach(rows, reconcileReply, { concurrency: config.pipelineConcurrency });
          return rows.length;
        }),
    } satisfies RepliesServiceShape;
  }),
);

export const ReplyWorkflowLive = ReplyWorkflow.toLayer((payload) =>
  Effect.gen(function* () {
    const service = yield* RepliesService;
    let control = yield* Activity.make({
      name: "reply-prepare",
      success: ReplyStepControl,
      execute: service.prepareStep(payload.replyId),
    });
    while (!terminalControl(control)) {
      const cursor = control.cursor;
      control =
        control.outcome === "tool_calls"
          ? yield* Activity.make({
              name: `reply-tool-turn-${cursor}`,
              success: ReplyStepControl,
              execute: service.toolStep(payload.replyId, cursor),
            })
          : yield* Activity.make({
              name: `reply-model-turn-${cursor}`,
              success: ReplyStepControl,
              execute: service.modelStep(payload.replyId, cursor),
            });
    }
    if (
      control.outcome === "done" ||
      control.outcome === "failed" ||
      control.outcome === "stopped"
    ) {
      yield* Activity.make({
        name: "reply-finalize",
        success: Schema.Void,
        execute: service.finalizeStep(payload.replyId, control.outcome, control.error),
      });
    }
  }),
);

export const ReplyReconcilerLoopLive = Layer.effectDiscard(
  Effect.flatMap(RepliesService, (service) =>
    backgroundLoop({
      failureEvent: "reply_reconciler_tick_failed",
      interval: "5 seconds",
      tick: service.reconcileOnce(),
    }),
  ),
);
