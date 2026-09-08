import { isDeepStrictEqual } from "node:util";

import { Database, replies, sessions as sessionsTable, vaults } from "@great-minds/database";
import {
  BadRequest,
  type CreateReplyRequest,
  CreateReplyRequest as CreateReplyRequestSchema,
  type CreateReplyResponse,
  composeAnchoredQuestion,
  Conflict,
  Forbidden,
  NotFound,
  type QueryRequest,
  type QuerySourceData,
  type ReplySnapshot,
  ReplySnapshot as ReplySnapshotSchema,
  type ReplySource,
  ReplySource as ReplySourceSchema,
  type ReplySseEvent,
  ServiceUnavailable,
  type SessionId,
  Uuid,
} from "@great-minds/domain";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Option, Schema, SchemaGetter, Stream } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";

import { backgroundLoop } from "./background-loop.ts";
import { AppConfig } from "./config.ts";
import { StructuredLogger } from "./logging.ts";
import { pollingSse } from "./polling-sse.ts";
import {
  QueryExecutionState,
  type QueryPrecheckedContext,
  type QueryPreparedToolCall as QueryPreparedToolCallType,
  QueryPreparedToolCall,
  QueryService,
} from "./query.ts";
import { type ReplyTranscript, SessionsService } from "./sessions.ts";
import { ContentStorage, vaultOwner } from "./storage.ts";
import { VaultAccessService } from "./vaults.ts";

const terminalStatuses = new Set(["completed", "failed"]);
const sanitizedReplyError = "Something went wrong while answering. Try again in a minute.";
const ambiguousReplyError =
  "Reply interrupted before an external response could be saved. It was not retried automatically.";
const flushIntervalMs = 125;

const decodeCreateReply = Schema.decodeUnknownEffect(CreateReplyRequestSchema);
const encodeReplySnapshot = Schema.encodeSync(Schema.fromJsonString(ReplySnapshotSchema));

const ReplyStepControl = Schema.Struct({
  cursor: Schema.Number,
  outcome: Schema.Literals(["ready", "retryable", "tool_calls", "done", "failed"] as const),
  error: Schema.NullOr(Schema.String),
});
type ReplyStepControl = typeof ReplyStepControl.Type;

const ReplyAccumulator = Schema.Struct({
  answer: Schema.mutableKey(Schema.String),
  sources: Schema.mutable(Schema.Array(ReplySourceSchema)),
  pendingCalls: Schema.Array(
    Schema.Struct({ callId: Schema.String, index: Schema.NullOr(Schema.Number) }),
  ).pipe(Schema.decodeTo(Schema.instanceOf(Map<string, number | null>), {
    decode: SchemaGetter.transform((entries) =>
      new Map(entries.map(({ callId, index }) => [callId, index])),
    ),
    encode: SchemaGetter.transform((entries) =>
      [...entries].map(([callId, index]) => ({ callId, index })),
    ),
  })),
  clearOnNextToken: Schema.mutableKey(Schema.Boolean),
  replacementSlot: Schema.mutableKey(Schema.NullOr(Schema.Number)),
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

const modelQuestion = (input: CreateReplyRequest, threadRoot: boolean): string => {
  if (
    input.kind === "exchange" &&
    "create" in input &&
    input.create.origin?.anchor !== null &&
    input.create.origin?.anchor !== undefined
  ) {
    return composeAnchoredQuestion(
      { quote: input.create.origin.anchor, context: input.create.origin.paragraph },
      input.question,
    );
  }
  if (input.kind === "btw" && threadRoot) {
    return composeAnchoredQuestion(
      { quote: input.btw.quote, context: input.btw.context },
      input.question,
    );
  }
  return input.question;
};

const queryRequest = (input: CreateReplyRequest, threadRoot: boolean): QueryRequest => ({
  question: modelQuestion(input, threadRoot),
  mode: input.mode,
  ...(input.model === undefined ? {} : { model: input.model }),
  ...(input.origin_path === undefined ? {} : { origin_path: input.origin_path }),
  origin_scope: input.origin_scope,
  ...(input.extra_instructions === undefined
    ? {}
    : { extra_instructions: input.extra_instructions }),
});

const sourceRef = (data: QuerySourceData, thinking: string, pending = false): ReplySource => {
  const source: ReplySource = {
    label: data.type === "search"
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
    path: data.type === "search" ? data.path ?? null : null,
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

export const ReplyWorkflow = Workflow.make("ReplyGeneration", {
  payload: { replyId: Uuid },
  idempotencyKey: ({ replyId }) => replyId,
  success: Schema.Void,
});

const dispatchReply = (
  replyId: Uuid,
  workflowEngine: WorkflowEngine.WorkflowEngine["Service"],
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* ReplyWorkflow.execute({ replyId }, { discard: true }).pipe(
      Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine),
    );
    yield* db.query((d) => d
      .update(replies)
      .set({
        dispatchedAt: sql`coalesce(${replies.dispatchedAt}, now())`,
        dispatchedTaskId: replyId,
        updatedAt: sql`now()`,
      })
      .where(eq(replies.id, replyId)));
  });

type RepliesServiceShape = {
  readonly create: (
    userId: Uuid,
    vaultId: Uuid,
    input: CreateReplyRequest,
  ) => Effect.Effect<CreateReplyResponse, Conflict | Forbidden | NotFound | ServiceUnavailable>;
  readonly retry: (
    userId: Uuid,
    vaultId: Uuid,
    replyId: Uuid,
    nextReplyId: Uuid,
  ) => Effect.Effect<
    CreateReplyResponse,
    BadRequest | Conflict | Forbidden | NotFound | ServiceUnavailable
  >;
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
    outcome: "done" | "failed",
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
    const storage = yield* ContentStorage;
    const workflowEngine = yield* WorkflowEngine.WorkflowEngine;
    const pollIntervalMs = Option.isSome(config.goldensClock) ? 1 : 100;

    const readReply = (vaultId: Uuid, replyId: Uuid) =>
      db.query((d) => d
        .select()
        .from(replies)
        .where(and(eq(replies.id, replyId), eq(replies.vaultId, vaultId)))
        .limit(1))
        .pipe(Effect.map((rows) => rows[0]));

    const readReplyById = (replyId: Uuid) =>
      db.query((d) => d
        .select()
        .from(replies)
        .where(eq(replies.id, replyId))
        .limit(1))
        .pipe(Effect.map((rows) => rows[0]));

    const requireSession = (vaultId: Uuid, sessionId: SessionId) =>
      db.query((d) => d
        .select({ id: sessionsTable.id })
        .from(sessionsTable)
        .where(and(eq(sessionsTable.vaultId, vaultId), eq(sessionsTable.id, sessionId)))
        .limit(1))
        .pipe(Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(new NotFound({ detail: "Session not found" }))
          : Effect.void,
      ));

    const snapshot = (row: typeof replies.$inferSelect): ReplySnapshot => ({
      reply_id: row.id,
      session_id: row.sessionId,
      kind: row.kind,
      status: row.status,
      answer: row.answer,
      sources: row.sources,
      error: row.error,
      version: row.version,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    });

    const updateSnapshot = (
      replyId: Uuid,
      answer: string,
      sources: readonly ReplySource[],
    ) =>
      db.query((d) => d
        .update(replies)
        .set({
          answer,
          sources,
          version: sql`${replies.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(replies.id, replyId), eq(replies.status, "running"))))
        .pipe(Effect.asVoid);

    const markFailed = (
      replyId: Uuid,
      error: string,
      answer?: string,
      sources?: readonly ReplySource[],
    ) =>
      db.query((d) => d
        .update(replies)
        .set({
          status: "failed",
          error,
          ...(answer === undefined ? {} : { answer }),
          ...(sources === undefined ? {} : { sources }),
          version: sql`${replies.version} + 1`,
          activeGenerationStep: null,
          activeGenerationKind: null,
          activeGenerationKey: null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(replies.id, replyId), eq(replies.status, "running"))))
        .pipe(Effect.asVoid);

    const completeReplyRow = (row: typeof replies.$inferSelect, answer: string, sources: readonly ReplySource[]) =>
      db.query((d) => d
        .update(replies)
        .set({
          status: "completed",
          answer,
          sources,
          error: null,
          version: sql`${replies.version} + 1`,
          activeGenerationStep: null,
          activeGenerationKind: null,
          activeGenerationKey: null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(replies.id, row.id), eq(replies.status, "running"))))
        .pipe(Effect.asVoid);

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

    const readCheckpoint = (row: typeof replies.$inferSelect) =>
      storage.readText(vaultOwner(row.vaultId), checkpointPath(row.id)).pipe(
        Effect.map(decodeReplyCheckpoint),
        Effect.catchTag("StorageFileMissing", () => Effect.succeed(undefined)),
      );

    const writeCheckpoint = (row: typeof replies.$inferSelect, checkpoint: ReplyCheckpoint) =>
      storage.writeText(
        vaultOwner(row.vaultId),
        checkpointPath(row.id),
        encodeReplyCheckpoint(checkpoint),
      );

    const removeSource = (accumulator: ReplyAccumulator, index: number) => {
      accumulator.sources.splice(index, 1);
      for (const [callId, pendingIndex] of accumulator.pendingCalls) {
        if (pendingIndex !== null && pendingIndex > index) {
          accumulator.pendingCalls.set(callId, pendingIndex - 1);
        }
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
            source.label === data.path &&
            (source.type === "article" || source.type === "raw"),
        )
      ) {
        accumulator.pendingCalls.set(callId, null);
      } else {
        accumulator.pendingCalls.set(callId, accumulator.sources.length);
        accumulator.sources.push(sourceRef(data, accumulator.answer, true));
        accumulator.clearOnNextToken = true;
      }
    };

    const settlePendingSource = (accumulator: ReplyAccumulator, callId: string) => {
      const pendingIndex = accumulator.pendingCalls.get(callId);
      accumulator.pendingCalls.delete(callId);
      if (pendingIndex !== undefined && pendingIndex !== null) {
        accumulator.replacementSlot = pendingIndex;
      }
    };

    const addResolvedSource = (
      accumulator: ReplyAccumulator,
      data: QuerySourceData,
    ) => {
      const pendingIndex = accumulator.replacementSlot;
      accumulator.replacementSlot = null;
      if (data.type === "article" || data.type === "raw") {
        if (pendingIndex !== null) {
          removeSource(accumulator, pendingIndex);
        }
        const isExpand = data.start !== undefined && data.end !== undefined;
        const range = isExpand ? { start: data.start, end: data.end } : null;
        const index = accumulator.sources.findIndex(
          (source) =>
            source.label === data.path &&
            (source.type === "article" || source.type === "raw"),
        );
        if (index >= 0) {
          const previous = accumulator.sources[index];
          accumulator.sources[index] = {
            ...previous,
            ranges: range ? [...(previous.ranges ?? []), range] : previous.ranges,
            full: previous.full || !isExpand,
          };
        } else {
          accumulator.sources.push(sourceRef(data, accumulator.answer));
        }
        accumulator.clearOnNextToken = true;
        return;
      }

      if (data.type === "links") {
        const existingIndex = accumulator.sources.findIndex(
          (source, index) =>
            index !== pendingIndex && source.type === "links" && source.label === data.path,
        );
        if (existingIndex >= 0) {
          if (pendingIndex !== null) {
            removeSource(accumulator, pendingIndex);
          }
          return;
        }
      }

      const resolved = sourceRef(data, accumulator.answer);
      if (pendingIndex === null) {
        accumulator.sources.push(resolved);
      } else {
        accumulator.sources.splice(pendingIndex, 1, resolved);
      }
      accumulator.clearOnNextToken = true;
    };

    const flushAccumulator = (replyId: Uuid, accumulator: ReplyAccumulator) =>
      updateSnapshot(replyId, accumulator.answer, accumulator.sources);

    const failRunningReply = (replyId: Uuid, error: string) =>
      Effect.gen(function* () {
        const row = yield* readReplyById(replyId);
        if (row === undefined || row.status !== "running") return;
        const sources = row.sources.filter((source) => source.pending !== true);
        yield* markFailed(replyId, error, row.answer, sources);
      });

    const stepFailure = (replyId: Uuid, cursor: number, cause: Cause.Cause<unknown>) => {
      if (cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason)) {
        return Effect.interrupt;
      }
      return logger
        .error("reply_generation_step_failed", {
          reply_id: replyId,
          generation_cursor: cursor,
          error_message: Cause.pretty(cause),
        })
        .pipe(
          Effect.andThen(failRunningReply(replyId, sanitizedReplyError)),
          Effect.as(failedControl(cursor, sanitizedReplyError)),
        );
    };

    const recoverCompletedStep = (
      row: typeof replies.$inferSelect,
      checkpoint: ReplyCheckpoint,
      expectedCursor: number,
    ) =>
      Effect.gen(function* () {
        if (checkpoint.cursor <= expectedCursor) return undefined;
        yield* db.query((d) => d
          .update(replies)
          .set({
            generationCursor: checkpoint.cursor,
            activeGenerationStep: null,
            activeGenerationKind: null,
            activeGenerationKey: null,
            updatedAt: sql`now()`,
          })
          .where(eq(replies.id, row.id)));
        return checkpoint.lastControl;
      });

    const claimExternalStep = (
      row: typeof replies.$inferSelect,
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
        if (row.activeGenerationStep !== null) {
          yield* failRunningReply(row.id, ambiguousReplyError);
          return failedControl(expectedCursor, ambiguousReplyError);
        }
        const claimed = yield* db.query((d) => d
          .update(replies)
          .set({
            activeGenerationStep: expectedCursor,
            activeGenerationKind: kind,
            activeGenerationKey: key,
            updatedAt: sql`now()`,
          })
          .where(and(
            eq(replies.id, row.id),
            eq(replies.status, "running"),
            eq(replies.generationCursor, expectedCursor),
            isNull(replies.activeGenerationStep),
          ))
          .returning({ id: replies.id }));
        if (claimed.length !== 1) {
          throw new Error(`Reply ${row.id} generation step ${expectedCursor} was not claimable`);
        }
        return undefined;
      });

    const commitExternalStep = (
      row: typeof replies.$inferSelect,
      checkpoint: ReplyCheckpoint,
    ) =>
      Effect.gen(function* () {
        yield* writeCheckpoint(row, checkpoint);
        yield* db.query((d) => d
          .update(replies)
          .set({
            generationCursor: checkpoint.cursor,
            activeGenerationStep: null,
            activeGenerationKind: null,
            activeGenerationKey: null,
            updatedAt: sql`now()`,
          })
          .where(eq(replies.id, row.id)));
      });

    const prepareStep = (replyId: Uuid) =>
      Effect.gen(function* () {
        const row = yield* readReplyById(replyId);
        if (row === undefined) return failedControl(0, sanitizedReplyError);
        const existing = yield* readCheckpoint(row);
        if (existing !== undefined) return existing.lastControl;
        if (row.status !== "running") {
          return row.status === "completed"
            ? doneControl(row.generationCursor)
            : failedControl(row.generationCursor, row.error ?? sanitizedReplyError);
        }
        const input = yield* decodeCreateReply(row.request).pipe(Effect.orDie);
        let transcript: ReplyTranscript = { prior: [], threadRoot: false };
        if (input.kind !== "ephemeral") {
          if (row.sessionId === null) {
            throw new Error(`Reply ${row.id} is missing its session`);
          }
          transcript = yield* sessions.readTranscript(
            row.vaultId,
            row.sessionId,
            row.id,
          );
        }
        const vaultRows = yield* db.query((d) => d
          .select({ name: vaults.name })
          .from(vaults)
          .where(eq(vaults.id, row.vaultId))
          .limit(1));
        const vault = vaultRows[0];
        if (vault === undefined) {
          yield* markFailed(replyId, sanitizedReplyError);
          return failedControl(row.generationCursor, sanitizedReplyError);
        }
        const prechecked: QueryPrecheckedContext = { vaultLabel: vault.name };
        const queryState = yield* query.prepareExecution(
          row.userId,
          row.vaultId,
          queryRequest(input, transcript.threadRoot),
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
            replacementSlot: null,
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
        const row = yield* readReplyById(replyId);
        if (row === undefined) return failedControl(expectedCursor, sanitizedReplyError);
        const checkpoint = yield* readCheckpoint(row);
        if (checkpoint === undefined) {
          throw new Error(`Reply ${replyId} has no generation checkpoint`);
        }
        if (row.status !== "running") {
          return row.status === "completed"
            ? doneControl(row.generationCursor)
            : failedControl(row.generationCursor, row.error ?? sanitizedReplyError);
        }
        const claimed = yield* claimExternalStep(
          row,
          checkpoint,
          expectedCursor,
          "model",
          `${checkpoint.query.modelIndex}:${checkpoint.query.trace.llmRounds + 1}`,
        );
        if (claimed !== undefined) return claimed;

        const accumulator = checkpoint.accumulator;
        let lastFlushAt = 0;
        const outcome = yield* query.modelAttempt(checkpoint.query, (text) =>
          Effect.gen(function* () {
            if (accumulator.replacementSlot !== null) {
              removeSource(accumulator, accumulator.replacementSlot);
              accumulator.replacementSlot = null;
            }
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
        );
        let control: ReplyStepControl;
        let pendingTools: readonly QueryPreparedToolCallType[] = [];
        if (outcome.kind === "tool_calls") {
          for (const toolCall of outcome.toolCalls) {
            if (toolCall.pendingSource !== undefined) {
              addPendingSource(accumulator, toolCall.id, toolCall.pendingSource);
            }
          }
          pendingTools = outcome.toolCalls;
          control = {
            cursor: expectedCursor + 1,
            outcome: "tool_calls",
            error: null,
          };
        } else if (outcome.kind === "retryable") {
          accumulator.clearOnNextToken = true;
          control = {
            cursor: expectedCursor + 1,
            outcome: "retryable",
            error: null,
          };
        } else if (outcome.kind === "done") {
          control = {
            cursor: expectedCursor + 1,
            outcome: "done",
            error: null,
          };
        } else {
          control = failedControl(expectedCursor + 1, outcome.error);
        }
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
        yield* commitExternalStep(row, nextCheckpoint);
        return control;
      }).pipe(Effect.catchCause((cause) => stepFailure(replyId, expectedCursor, cause)));

    const toolStep = (replyId: Uuid, expectedCursor: number) =>
      Effect.gen(function* () {
        const row = yield* readReplyById(replyId);
        if (row === undefined) return failedControl(expectedCursor, sanitizedReplyError);
        const checkpoint = yield* readCheckpoint(row);
        if (checkpoint === undefined) {
          throw new Error(`Reply ${replyId} has no generation checkpoint`);
        }
        if (row.status !== "running") {
          return failedControl(row.generationCursor, row.error ?? sanitizedReplyError);
        }
        const toolCall = checkpoint.pendingTools[checkpoint.nextToolIndex];
        if (toolCall === undefined) {
          throw new Error(`Reply ${replyId} has no pending tool at ${checkpoint.nextToolIndex}`);
        }
        const claimed = yield* claimExternalStep(
          row,
          checkpoint,
          expectedCursor,
          "tool",
          toolCall.id,
        );
        if (claimed !== undefined) return claimed;

        const accumulator = checkpoint.accumulator;
        const result = yield* query.runTool(checkpoint.query, toolCall);
        if (toolCall.pendingSource !== undefined) {
          settlePendingSource(accumulator, toolCall.id);
        }
        if (result.source !== undefined) {
          addResolvedSource(accumulator, result.source);
        } else if (accumulator.replacementSlot !== null) {
          removeSource(accumulator, accumulator.replacementSlot);
          accumulator.replacementSlot = null;
        }
        yield* flushAccumulator(replyId, accumulator);

        const nextToolIndex = checkpoint.nextToolIndex + 1;
        const remaining = checkpoint.pendingTools.length - nextToolIndex;
        const control: ReplyStepControl =
          remaining > 0
            ? {
                cursor: expectedCursor + 1,
                outcome: "tool_calls",
                error: null,
              }
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

    const finalizeStep = (
      replyId: Uuid,
      outcome: "done" | "failed",
      error: string | null,
    ) =>
      Effect.gen(function* () {
        const row = yield* readReplyById(replyId);
        if (row === undefined) return;
        const checkpoint = yield* readCheckpoint(row);
        if (checkpoint !== undefined) {
          yield* query.finalizeExecution(checkpoint.query);
        }
        if (row.status === "running") {
          const accumulator =
            checkpoint === undefined
              ? { answer: row.answer, sources: row.sources }
              : checkpoint.accumulator;
          const settledSources = accumulator.sources.filter((source) => source.pending !== true);
          if (outcome === "done") {
            if (row.sessionId !== null) {
              if (checkpoint === undefined) {
                return yield* Effect.die(
                  new Error(`Reply ${replyId} finished without a checkpoint transcript`),
                );
              }
              yield* sessions.completeReply(
                row.userId,
                row.vaultId,
                row.sessionId,
                replyId,
                {
                  messages: checkpoint.query.messages.slice(checkpoint.query.turnStart),
                  sources: settledSources,
                  answer: accumulator.answer,
                },
              );
            }
            yield* completeReplyRow(row, accumulator.answer, settledSources);
          } else {
            yield* markFailed(
              replyId,
              error ?? sanitizedReplyError,
              accumulator.answer,
              settledSources,
            );
          }
        }
      }).pipe(
        Effect.catchCause((cause) => {
          if (cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason)) {
            return Effect.interrupt;
          }
          return logger
            .error("reply_generation_finalize_failed", {
              reply_id: replyId,
              error_message: Cause.pretty(cause),
            })
            .pipe(Effect.andThen(failRunningReply(replyId, sanitizedReplyError)));
        }),
      );

    const dispatchBestEffort = (replyId: Uuid) =>
      dispatchReply(replyId, workflowEngine).pipe(
        Effect.provideService(Database, db),
        Effect.catchCause((cause) =>
          logger.warn("reply_dispatch_deferred", {
            reply_id: replyId,
            error_message: Cause.pretty(cause),
          }),
        ),
      );

    const acceptedResponseFor = (
      row: typeof replies.$inferSelect,
      userId: Uuid,
      vaultId: Uuid,
      input: CreateReplyRequest,
    ) =>
      Effect.gen(function* () {
        const storedInput = yield* decodeCreateReply(row.request).pipe(Effect.orDie);
        if (
          row.userId !== userId ||
          row.vaultId !== vaultId ||
          !isDeepStrictEqual(storedInput, input)
        ) {
          return yield* new Conflict({
            detail: "Reply id already belongs to another request",
          });
        }
        return {
          reply_id: row.id,
          session_id: row.sessionId,
        };
      });

    const acceptReply = (
      userId: Uuid,
      vaultId: Uuid,
      input: CreateReplyRequest,
      existingSessionId?: SessionId,
    ) =>
      Effect.gen(function* () {
        const vaultRows = yield* db.query((d) => d
          .select({ id: vaults.id })
          .from(vaults)
          .where(eq(vaults.id, vaultId))
          .limit(1));
        if (vaultRows[0] === undefined) {
          return yield* new NotFound({ detail: "Vault not found" });
        }
        yield* access.requireMember(userId, vaultId);

        const replyId = input.reply_id;
        const accepted = yield* readReplyById(replyId);
        if (accepted !== undefined) {
          return yield* acceptedResponseFor(accepted, userId, vaultId, input);
        }
        if (Option.isNone(config.openRouterApiKey)) {
          return yield* new ServiceUnavailable({
            detail: "LLM service not configured (OPENROUTER_API_KEY missing)",
          });
        }

        let sessionId: SessionId | null = null;
        if (input.kind === "exchange" && "create" in input && existingSessionId === undefined) {
          sessionId = yield* sessions.createSession(userId, vaultId, {
            idempotencyKey: input.create.idempotency_key,
            ...(input.create.origin === undefined
              ? {}
              : {
                  origin: {
                    ...input.create.origin,
                    origin_scope: input.create.origin_scope,
                  },
                }),
            pending: {
              replyId: input.reply_id,
              exchangeId: input.exchange_id,
              question: input.question,
            },
          });
        } else if (input.kind !== "ephemeral") {
          sessionId = existingSessionId ?? ("session_id" in input ? input.session_id : null);
          if (sessionId === null) {
            return yield* Effect.die(new Error(`Reply ${replyId} has no session to append to`));
          }
          yield* requireSession(vaultId, sessionId);
          yield* sessions.appendPending(userId, vaultId, sessionId, {
            replyId: input.reply_id,
            exchangeId: input.exchange_id,
            question: input.question,
            ...(input.kind === "btw"
              ? {
                  btw: {
                    exchange_id: input.btw.exchangeId,
                    quote: input.btw.quote,
                    block_offset: input.btw.blockOffset,
                    context: input.btw.context,
                  },
                }
              : {}),
          });
        }

        const inserted = yield* db.query((d) => d
          .insert(replies)
          .values({
            id: replyId,
            vaultId,
            userId,
            sessionId,
            kind: input.kind,
            status: "running",
            answer: "",
            sources: [],
            request: input,
          })
          .onConflictDoNothing({ target: replies.id })
          .returning({ id: replies.id }));
        if (inserted.length === 0) {
          const concurrent = yield* readReplyById(replyId);
          if (concurrent === undefined) {
            throw new Error(`Reply ${replyId} conflicted but could not be read`);
          }
          return yield* acceptedResponseFor(concurrent, userId, vaultId, input);
        }
        yield* dispatchBestEffort(replyId);
        return { reply_id: replyId, session_id: sessionId };
      });

    return {
      create: (userId, vaultId, input) => acceptReply(userId, vaultId, input),
      retry: (userId, vaultId, replyId, nextReplyId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const previous = yield* readReply(vaultId, replyId);
          if (previous === undefined || previous.userId !== userId) {
            return yield* new NotFound({ detail: "Reply not found" });
          }
          if (previous.status !== "failed") {
            return yield* new BadRequest({ detail: "Only failed replies can be retried" });
          }
          if (nextReplyId === replyId) {
            return yield* new BadRequest({ detail: "Retry requires a new reply id" });
          }
          const previousInput = yield* decodeCreateReply(previous.request).pipe(Effect.orDie);
          const input: CreateReplyRequest = {
            ...previousInput,
            reply_id: nextReplyId,
          };
          const sessionId =
            previous.sessionId === null ? undefined : previous.sessionId;
          return yield* acceptReply(userId, vaultId, input, sessionId);
        }),
      stream: (userId, vaultId, replyId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const initial = yield* readReply(vaultId, replyId);
          if (initial === undefined) {
            return yield* new NotFound({ detail: "Reply not found" });
          }

          return pollingSse(replyId, readReply(vaultId, replyId), (row) => {
            const current = snapshot(row);
            return {
              version: row.version,
              data: encodeReplySnapshot(current),
              terminal: terminalStatuses.has(current.status),
            };
          }, pollIntervalMs);
        }),
      prepareStep,
      modelStep,
      toolStep,
      finalizeStep,
      reconcileOnce: () =>
        Effect.gen(function* () {
          const rows = yield* db.query((d) => d
            .select({ id: replies.id })
            .from(replies)
            .where(and(eq(replies.status, "running"), isNull(replies.dispatchedAt)))
            .orderBy(asc(replies.createdAt))
            .limit(100));
          yield* Effect.forEach(
            rows,
            (row) => dispatchBestEffort(row.id),
            { concurrency: config.pipelineConcurrency },
          );
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

    while (control.outcome !== "done" && control.outcome !== "failed") {
      if (control.outcome === "tool_calls") {
        const cursor = control.cursor;
        control = yield* Activity.make({
          name: `reply-tool-turn-${cursor}`,
          success: ReplyStepControl,
          execute: service.toolStep(payload.replyId, cursor),
        });
      } else {
        const cursor = control.cursor;
        control = yield* Activity.make({
          name: `reply-model-turn-${cursor}`,
          success: ReplyStepControl,
          execute: service.modelStep(payload.replyId, cursor),
        });
      }
    }

    yield* Activity.make({
      name: "reply-finalize",
      success: Schema.Void,
      execute: service.finalizeStep(payload.replyId, control.outcome, control.error),
    });
  }),
);

export const ReplyReconcilerLoopLive = Layer.effectDiscard(
  Effect.flatMap(RepliesService, (replies) =>
    backgroundLoop({
      failureEvent: "reply_reconciler_tick_failed",
      interval: "5 seconds",
      tick: replies.reconcileOnce(),
    })),
);
