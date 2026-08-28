import { isDeepStrictEqual } from "node:util";

import { Database, replies, sessions as sessionsTable, vaults } from "@great-minds/database";
import {
  BadRequest,
  type BtwData,
  type CreateReplyRequest,
  CreateReplyRequest as CreateReplyRequestSchema,
  type CreateReplyResponse,
  Conflict,
  type ExchangeData,
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
  SessionId as SessionIdSchema,
  type SessionOrigin,
  type Uuid,
  Uuid as UuidSchema,
} from "@great-minds/domain";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Option, Schema, Stream } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";

import { AppConfig } from "./config.ts";
import { StructuredLogger } from "./logging.ts";
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

const terminalStatuses = new Set(["completed", "failed"]);
const sanitizedReplyError = "Something went wrong while answering. Try again in a minute.";
const ambiguousReplyError =
  "Reply interrupted before an external response could be saved. It was not retried automatically.";
const flushIntervalMs = 125;

const decodeCreateReply = Schema.decodeUnknownEffect(CreateReplyRequestSchema);
const decodeReplySnapshot = Schema.decodeUnknownSync(ReplySnapshotSchema);
const decodeSessionId = Schema.decodeUnknownSync(SessionIdSchema);
const decodeUuid = Schema.decodeUnknownSync(UuidSchema);

const ReplyStepControl = Schema.Struct({
  cursor: Schema.Number,
  outcome: Schema.Literals(["ready", "retryable", "tool_calls", "done", "failed"] as const),
  error: Schema.NullOr(Schema.String),
});
type ReplyStepControl = typeof ReplyStepControl.Type;

const ReplyAccumulator = Schema.Struct({
  answer: Schema.String,
  sources: Schema.Array(ReplySourceSchema),
  pendingCalls: Schema.Array(
    Schema.Struct({ callId: Schema.String, index: Schema.NullOr(Schema.Number) }),
  ),
  clearOnNextToken: Schema.Boolean,
  replacementSlot: Schema.NullOr(Schema.Number),
});
type ReplyAccumulator = typeof ReplyAccumulator.Type;

type MutableReplyAccumulator = {
  answer: string;
  sources: ReplySource[];
  pendingCalls: Map<string, number | null>;
  clearOnNextToken: boolean;
  replacementSlot?: number;
};

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

const decodeReplyCheckpoint = Schema.decodeUnknownSync(ReplyCheckpoint);
const decodeReplySources = Schema.decodeUnknownSync(Schema.Array(ReplySourceSchema));
const checkpointPath = (replyId: Uuid) => `operations/replies/${replyId}.json`;

const sse = (event: string, data: unknown): ReplySseEvent => ({
  event,
  data: typeof data === "string" ? data : JSON.stringify(data),
});

const replySseStream = <A>(events: AsyncIterable<A>) =>
  Stream.fromAsyncIterable(events, (cause) => cause).pipe(
    Stream.catch((cause) => Stream.fromEffect(Effect.die(cause))),
  );

const queryRequest = (input: CreateReplyRequest): QueryRequest => ({
  question:
    input.kind === "exchange" &&
    "create" in input &&
    input.create.origin !== undefined &&
    input.create.origin.anchor !== null
      ? composeAnchoredQuestion(input.create.origin, input.question)
      : input.question,
  mode: input.mode,
  history: input.history,
  ...(input.model === undefined ? {} : { model: input.model }),
  ...(input.origin_path === undefined ? {} : { origin_path: input.origin_path }),
  origin_scope: input.origin_scope,
  ...(input.extra_instructions === undefined
    ? {}
    : { extra_instructions: input.extra_instructions }),
});

// Mirrors web/src/lib/utils.ts buildBtwQuery: the surrounding paragraph first,
// then the highlighted quote (when distinct), then the user's clean question.
// Used only for the anchored first turn of a doc-born session; the session
// itself stores the clean question and the composed text never persists.
export const composeAnchoredQuestion = (origin: SessionOrigin, question: string): string => {
  const parts: string[] = [];
  if (origin.paragraph !== null && origin.paragraph.length > 0) {
    parts.push(`Passage:\n> ${origin.paragraph}`);
  }
  if (origin.anchor !== null && origin.anchor !== origin.paragraph) {
    parts.push(`Highlighted: "${origin.anchor}"`);
  }
  parts.push(question);
  return parts.join("\n\n");
};

const sourceRef = (data: QuerySourceData, thinking: string, pending = false): ReplySource => {
  if (data.type === "article" || data.type === "raw") {
    const isExpand = data.start !== undefined && data.end !== undefined;
    return {
      label: data.path,
      type: data.type,
      document_id: data.document_id,
      title: data.title,
      scope: null,
      path: null,
      thinking: thinking.length === 0 ? null : thinking,
      ranges: isExpand ? [{ start: data.start, end: data.end }] : [],
      full: !isExpand,
      pending: pending || undefined,
    };
  }
  if (data.type === "search") {
    return {
      label: data.query,
      type: "search",
      document_id: null,
      scope: data.scope,
      path: data.path ?? null,
      title: data.title,
      thinking: thinking.length === 0 ? null : thinking,
      pending: pending || undefined,
    };
  }
  if (data.type === "links") {
    return {
      label: data.path,
      type: "links",
      document_id: null,
      title: data.title,
      scope: null,
      path: null,
      thinking: thinking.length === 0 ? null : thinking,
      pending: pending || undefined,
    };
  }
  if (data.type === "query") {
    const summary =
      Object.entries(data.filters)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(", ") || "filtered sources";
    return {
      label: summary,
      type: "query",
      document_id: null,
      title: null,
      scope: null,
      path: null,
      thinking: thinking.length === 0 ? null : thinking,
      pending: pending || undefined,
    };
  }
  throw new Error(`Unsupported query source: ${data.type}`);
};

export const ReplyWorkflow = Workflow.make("ReplyGeneration", {
  payload: { replyId: UuidSchema },
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

    const snapshot = (row: typeof replies.$inferSelect): ReplySnapshot =>
      decodeReplySnapshot({
        reply_id: row.id,
        session_id: row.sessionId,
        kind: row.kind,
        status: row.status,
        answer: row.answer,
        sources: row.sources,
        error: row.error,
        version: row.version,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
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
          sources: [...sources],
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
          ...(sources === undefined ? {} : { sources: [...sources] }),
          version: sql`${replies.version} + 1`,
          activeGenerationStep: null,
          activeGenerationKind: null,
          activeGenerationKey: null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(replies.id, replyId), eq(replies.status, "running"))))
        .pipe(Effect.asVoid);

    const completeReply = (
      row: typeof replies.$inferSelect,
      input: CreateReplyRequest,
      answer: string,
      sources: readonly ReplySource[],
    ) =>
      Effect.gen(function* () {
        const settledSources = sources.filter((source) => source.pending !== true);
        const userId = decodeUuid(row.userId);
        const vaultId = decodeUuid(row.vaultId);
        const persistedReplyId = decodeUuid(row.id);
        if (input.kind === "exchange") {
          if (row.sessionId === null) {
            throw new Error(`Exchange reply ${row.id} is missing its session`);
          }
          const exchange: ExchangeData = {
            id: input.exchange_id,
            query: input.question,
            thinking: [{ sources: settledSources }],
            answer,
          };
          yield* sessions.appendExchange(
            userId,
            vaultId,
            decodeSessionId(row.sessionId),
            exchange,
            persistedReplyId,
          );
        } else if (input.kind === "btw") {
          if (row.sessionId === null) {
            throw new Error(`BTW reply ${row.id} is missing its session`);
          }
          const lastIndex = input.btw.exchanges.length - 1;
          const btw: BtwData = {
            ...input.btw,
            exchanges: input.btw.exchanges.map((exchange, index) =>
              index === lastIndex
                ? {
                    ...exchange,
                    thinking: settledSources.length === 0 ? [] : [{ sources: settledSources }],
                    answer,
                  }
                : exchange,
            ),
          };
          yield* sessions.appendBtw(
            userId,
            vaultId,
            decodeSessionId(row.sessionId),
            btw,
            persistedReplyId,
          );
        }

        yield* db.query((d) => d
          .update(replies)
          .set({
            status: "completed",
            answer,
            sources: settledSources,
            error: null,
            version: sql`${replies.version} + 1`,
            activeGenerationStep: null,
            activeGenerationKind: null,
            activeGenerationKey: null,
            updatedAt: sql`now()`,
          })
          .where(and(eq(replies.id, row.id), eq(replies.status, "running"))));
      });

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

    const mutableAccumulator = (value: ReplyAccumulator): MutableReplyAccumulator => ({
      answer: value.answer,
      sources: [...value.sources],
      pendingCalls: new Map(value.pendingCalls.map((entry) => [entry.callId, entry.index])),
      clearOnNextToken: value.clearOnNextToken,
      ...(value.replacementSlot === null ? {} : { replacementSlot: value.replacementSlot }),
    });

    const persistedAccumulator = (value: MutableReplyAccumulator): ReplyAccumulator => ({
      answer: value.answer,
      sources: [...value.sources],
      pendingCalls: [...value.pendingCalls].map(([callId, index]) => ({ callId, index })),
      clearOnNextToken: value.clearOnNextToken,
      replacementSlot: value.replacementSlot ?? null,
    });

    const readCheckpoint = (row: typeof replies.$inferSelect) =>
      storage.readText(vaultOwner(decodeUuid(row.vaultId)), checkpointPath(decodeUuid(row.id))).pipe(
        Effect.map((content) => decodeReplyCheckpoint(JSON.parse(content))),
        Effect.catchTag("StorageFileMissing", () => Effect.succeed(undefined)),
      );

    const writeCheckpoint = (row: typeof replies.$inferSelect, checkpoint: ReplyCheckpoint) =>
      storage.writeText(
        vaultOwner(decodeUuid(row.vaultId)),
        checkpointPath(decodeUuid(row.id)),
        JSON.stringify(checkpoint),
      );

    const removeSource = (accumulator: MutableReplyAccumulator, index: number) => {
      accumulator.sources.splice(index, 1);
      for (const [callId, pendingIndex] of accumulator.pendingCalls) {
        if (pendingIndex !== null && pendingIndex > index) {
          accumulator.pendingCalls.set(callId, pendingIndex - 1);
        }
      }
    };

    const addPendingSource = (
      accumulator: MutableReplyAccumulator,
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

    const settlePendingSource = (accumulator: MutableReplyAccumulator, callId: string) => {
      const pendingIndex = accumulator.pendingCalls.get(callId);
      accumulator.pendingCalls.delete(callId);
      if (pendingIndex !== undefined && pendingIndex !== null) {
        accumulator.replacementSlot = pendingIndex;
      }
    };

    const addResolvedSource = (
      accumulator: MutableReplyAccumulator,
      data: QuerySourceData,
    ) => {
      const pendingIndex = accumulator.replacementSlot;
      accumulator.replacementSlot = undefined;
      if (data.type === "article" || data.type === "raw") {
        if (pendingIndex !== undefined) {
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
          if (pendingIndex !== undefined) {
            removeSource(accumulator, pendingIndex);
          }
          return;
        }
      }

      const resolved = sourceRef(data, accumulator.answer);
      if (pendingIndex === undefined) {
        accumulator.sources.push(resolved);
      } else {
        accumulator.sources.splice(pendingIndex, 1, resolved);
      }
      accumulator.clearOnNextToken = true;
    };

    const flushAccumulator = (replyId: Uuid, accumulator: MutableReplyAccumulator) =>
      updateSnapshot(replyId, accumulator.answer, accumulator.sources);

    const failRunningReply = (replyId: Uuid, error: string) =>
      Effect.gen(function* () {
        const row = yield* readReplyById(replyId);
        if (row === undefined || row.status !== "running") return;
        const sources = decodeReplySources(row.sources).filter((source) => source.pending !== true);
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
          yield* failRunningReply(decodeUuid(row.id), ambiguousReplyError);
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
        const queryState = yield* Effect.promise(() =>
          query.prepareExecution(
            decodeUuid(row.userId),
            decodeUuid(row.vaultId),
            queryRequest(input),
            prechecked,
          ),
        );
        const control = readyControl(row.generationCursor);
        const checkpoint: ReplyCheckpoint = {
          version: 1,
          cursor: row.generationCursor,
          query: queryState,
          accumulator: {
            answer: "",
            sources: [],
            pendingCalls: [],
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

        const accumulator = mutableAccumulator(checkpoint.accumulator);
        let lastFlushAt = 0;
        const attempt = query.modelAttempt(checkpoint.query);
        let result: Awaited<ReturnType<typeof attempt.next>>;
        while (true) {
          result = yield* Effect.promise(() => attempt.next());
          if (result.done === true) break;
          const event = result.value;
          if (event.event !== "token") {
            throw new Error(`Model attempt emitted unexpected ${event.event} event`);
          }
          if (accumulator.replacementSlot !== undefined) {
            removeSource(accumulator, accumulator.replacementSlot);
            accumulator.replacementSlot = undefined;
          }
          if (accumulator.clearOnNextToken) {
            accumulator.answer = "";
            accumulator.clearOnNextToken = false;
          }
          accumulator.answer += event.data.text;
          if (Date.now() - lastFlushAt >= flushIntervalMs) {
            yield* flushAccumulator(replyId, accumulator);
            lastFlushAt = Date.now();
          }
        }

        const outcome = result.value;
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
          accumulator: persistedAccumulator(accumulator),
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

        const accumulator = mutableAccumulator(checkpoint.accumulator);
        const result = yield* Effect.promise(() => query.runTool(checkpoint.query, toolCall));
        if (toolCall.pendingSource !== undefined) {
          settlePendingSource(accumulator, toolCall.id);
        }
        if (result.source !== undefined) {
          addResolvedSource(accumulator, result.source);
        } else if (accumulator.replacementSlot !== undefined) {
          removeSource(accumulator, accumulator.replacementSlot);
          accumulator.replacementSlot = undefined;
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
          accumulator: persistedAccumulator(accumulator),
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
          yield* Effect.promise(() => query.finalizeExecution(checkpoint.query));
        }
        yield* storage
          .deletePath(vaultOwner(decodeUuid(row.vaultId)), checkpointPath(replyId))
          .pipe(
            Effect.catchCause((cause) =>
              logger.warn("reply_checkpoint_cleanup_failed", {
                reply_id: replyId,
                error_message: Cause.pretty(cause),
              }),
            ),
          );
        if (row.status === "running") {
          const input = yield* decodeCreateReply(row.request).pipe(Effect.orDie);
          const accumulator =
            checkpoint === undefined
              ? { answer: row.answer, sources: decodeReplySources(row.sources) }
              : checkpoint.accumulator;
          const settledSources = accumulator.sources.filter((source) => source.pending !== true);
          if (outcome === "done") {
            yield* completeReply(row, input, accumulator.answer, settledSources);
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
          reply_id: decodeUuid(row.id),
          session_id: row.sessionId === null ? null : decodeSessionId(row.sessionId),
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
        if (input.kind === "exchange") {
          const pending: ExchangeData = {
            id: input.exchange_id,
            query: input.question,
            thinking: [],
            answer: "",
          };
          if (existingSessionId !== undefined) {
            sessionId = existingSessionId;
            yield* requireSession(vaultId, sessionId);
            yield* sessions.appendExchange(userId, vaultId, sessionId, pending, replyId);
          } else if ("session_id" in input) {
            sessionId = input.session_id;
            yield* requireSession(vaultId, sessionId);
            yield* sessions.appendExchange(userId, vaultId, sessionId, pending, replyId);
          } else {
            sessionId = yield* sessions.createSession(
              userId,
              vaultId,
              {
                idempotencyKey: input.create.idempotency_key,
                exchange: pending,
                ...(input.create.origin === undefined
                  ? {}
                  : {
                      origin: {
                        ...input.create.origin,
                        origin_scope: input.create.origin_scope,
                      },
                    }),
              },
              replyId,
            );
          }
        } else if (input.kind === "btw") {
          sessionId = existingSessionId ?? input.session_id;
          yield* requireSession(vaultId, sessionId);
          yield* sessions.appendBtw(userId, vaultId, sessionId, input.btw, replyId);
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
            previous.sessionId === null ? undefined : decodeSessionId(previous.sessionId);
          return yield* acceptReply(userId, vaultId, input, sessionId);
        }),
      stream: (userId, vaultId, replyId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const initial = yield* readReply(vaultId, replyId);
          if (initial === undefined) {
            return yield* new NotFound({ detail: "Reply not found" });
          }

          async function* events() {
            yield sse("connected", { id: replyId });
            let previousVersion = -1;
            let heartbeatAt = Date.now() + 30_000;
            while (true) {
              const row = await Effect.runPromise(readReply(vaultId, replyId));
              if (row !== undefined && row.version !== previousVersion) {
                previousVersion = row.version;
                const current = snapshot(row);
                yield sse("message", current);
                if (terminalStatuses.has(current.status)) {
                  yield sse("done", { id: replyId });
                  return;
                }
              }
              if (Date.now() >= heartbeatAt) {
                yield sse("message", "");
                heartbeatAt = Date.now() + 30_000;
              }
              await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            }
          }

          return replySseStream(events());
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
            (row) => dispatchBestEffort(row.id as Uuid),
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
  Effect.gen(function* () {
    const replies = yield* RepliesService;
    const logger = yield* StructuredLogger;
    const tick = replies.reconcileOnce().pipe(
      Effect.catchCause((cause) =>
        logger.warn("reply_reconciler_tick_failed", {
          error_message: Cause.pretty(cause),
        }),
      ),
    );
    yield* tick;
    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep("5 seconds").pipe(Effect.andThen(tick))),
    );
  }),
);
