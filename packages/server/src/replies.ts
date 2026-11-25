import { Database, replies, vaults } from "@great-minds/database";
import {
  BadRequest,
  citationsOf,
  type CreateReplyRequest,
  type CreateReplyResponse,
  Conflict,
  Forbidden,
  NotFound,
  isReplyPending,
  type QuerySourceData,
  ReplySnapshot as ReplySnapshotSchema,
  type ReplySource,
  type ReplySnapshot,
  type ReplySseEvent,
  ServiceUnavailable,
  SessionActivity,
  ThinkingSource,
  Uuid,
} from "@great-minds/domain";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { Cause, Context, Data, Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import * as Activity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";

import { backgroundLoop } from "./background-loop.ts";
import { AppConfig } from "./config.ts";
import {
  acceptedRequestFor,
  ReplyAdmission,
  type ReplyAdmissionError,
} from "./conversation-history/admission.ts";
import { type GenerationMetadata, ReplyFailure } from "./conversation-history/schema.ts";
import { ReplySettlement, type ReplySettlementResult } from "./conversation-history/settlement.ts";
import type { LlmMessage } from "./llm.ts";
import { errorDetails } from "./error-details.ts";
import { StructuredLogger } from "./logging.ts";
import { ProgressChanges } from "./progress-changes.ts";
import {
  QueryExecutionState,
  type QueryPreparedToolCall as QueryPreparedToolCallType,
  QueryPreparedToolCall,
  QueryService,
  sanitizedStreamError,
} from "./query.ts";
import { SessionsService } from "./sessions.ts";
import { snapshotSse } from "./snapshot-sse.ts";
import { ContentStorage, vaultOwner } from "./storage.ts";
import { liveVaultMember, VaultAccessService } from "./vaults.ts";

const generationFailed = (message: string = sanitizedStreamError): ReplyFailure => ({
  code: "generation_failed",
  message,
});
const outcomeUnknown: ReplyFailure = {
  code: "external_outcome_unknown",
  message:
    "Reply interrupted before an external response could be saved. It was not retried automatically.",
};
const interruptedFailure = (row: ReplyRow) =>
  row.activeGenerationStep === null ? generationFailed() : outcomeUnknown;
const flushIntervalMs = 125;
const encodeReplySnapshot = Schema.encodeSync(Schema.fromJsonString(ReplySnapshotSchema));

type ReplyRow = typeof replies.$inferSelect;

const replyNotFound = () => new NotFound({ detail: "Reply not found" });
const runningUnstoppedReply = (replyId: Uuid) =>
  and(eq(replies.id, replyId), eq(replies.status, "running"), eq(replies.stopRequested, false));

const replySnapshot = (row: ReplyRow): ReplySnapshot => ({
  reply_id: row.id,
  session_id: row.sessionId,
  status: row.status,
  answer: row.answer,
  citations: citationsOf(row.answer),
  sources: row.sources,
  error: row.error,
  version: row.version,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
});
type ReplyRequestError = BadRequest | Conflict | Forbidden | NotFound | ServiceUnavailable;

const ReplyEnd = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("done") }),
  Schema.Struct({ outcome: Schema.Literal("stopped") }),
  Schema.Struct({ outcome: Schema.Literal("failed"), failure: ReplyFailure }),
]);
type ReplyEnd = typeof ReplyEnd.Type;

const ReplyStepControl = Schema.Union([
  Schema.Struct({ cursor: Schema.Number, outcome: Schema.Literals(["ready", "tool_calls"]) }),
  ...ReplyEnd.members.map((member) => Schema.Struct({ cursor: Schema.Number, ...member.fields })),
]);
type ReplyStepControl = typeof ReplyStepControl.Type;

const ReplyAccumulator = Schema.Struct({
  answer: Schema.mutableKey(Schema.String),
  sources: Schema.mutable(
    Schema.Array(
      Schema.Struct({ source: ThinkingSource, pendingCallId: Schema.optionalKey(Schema.String) }),
    ),
  ),
  clearOnNextToken: Schema.mutableKey(Schema.Boolean),
});
type ReplyAccumulator = typeof ReplyAccumulator.Type;

const checkpointVersion = 2;
const ReplyCheckpoint = Schema.Struct({
  version: Schema.Literal(checkpointVersion),
  cursor: Schema.Number,
  query: QueryExecutionState,
  accumulator: ReplyAccumulator,
  pendingTools: Schema.Array(QueryPreparedToolCall),
  nextToolIndex: Schema.Number,
  lastControl: ReplyStepControl,
});
type ReplyCheckpoint = typeof ReplyCheckpoint.Type;

const decodeReplyCheckpoint = Schema.decodeUnknownEffect(Schema.fromJsonString(ReplyCheckpoint));
const encodeReplyCheckpoint = Schema.encodeSync(Schema.fromJsonString(ReplyCheckpoint));
const checkpointPath = (replyId: Uuid) => `operations/replies/${replyId}.json`;
const terminalControl = (control: ReplyStepControl): control is ReplyStepControl & ReplyEnd =>
  control.outcome !== "ready" && control.outcome !== "tool_calls";

const failureFields = (cause: Cause.Cause<unknown>) => {
  const reason = cause.reasons.find((reason) => !Cause.isInterruptReason(reason));
  const error =
    reason === undefined ? cause : Cause.isFailReason(reason) ? reason.error : reason.defect;
  const details = errorDetails(error);
  return {
    error_tag:
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      typeof error._tag === "string"
        ? error._tag
        : details.errorType,
    error_message: details.message,
  };
};
class ReplyInvariantBroken extends Data.TaggedError("ReplyInvariantBroken")<{
  readonly reply_id: Uuid;
  readonly message: string;
}> {}
const invariantBroken = (replyId: Uuid, message: string) =>
  Effect.die(new ReplyInvariantBroken({ reply_id: replyId, message }));
const readyControl = (cursor: number) => ({ cursor, outcome: "ready" }) as const;
const failedControl = (cursor: number, failure: ReplyFailure) =>
  ({ cursor, outcome: "failed", failure }) as const;
const doneControl = (cursor: number) => ({ cursor, outcome: "done" }) as const;
const stoppedControl = (cursor: number) => ({ cursor, outcome: "stopped" }) as const;

const sourceRef = (data: QuerySourceData, thinking: string, round: number): ThinkingSource => {
  const source: ThinkingSource = {
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
    round,
  };
  switch (data.type) {
    case "article":
    case "raw": {
      const isExpand = data.start !== undefined && data.end !== undefined;
      return {
        ...source,
        ranges: isExpand ? [{ start: data.start, end: data.end }] : [],
        full: data.full === true,
        ...(data.outline === true ? { outline: true } : {}),
        ...(data.chunks === undefined ? {} : { chunks: data.chunks }),
      };
    }
    case "search":
      return {
        ...source,
        ...(data.results === undefined ? {} : { results: data.results }),
        ...(data.hits === undefined ? {} : { hits: data.hits }),
      };
    default:
      return data.results === undefined ? source : { ...source, results: data.results };
  }
};

const resolveSource = (
  accumulator: ReplyAccumulator,
  callId: string,
  data: QuerySourceData | undefined,
  round: number,
) => {
  const { sources } = accumulator;
  const pendingIndex = sources.findIndex((entry) => entry.pendingCallId === callId);
  if (
    data === undefined ||
    (data.type === "links" &&
      sources.some(
        ({ source, pendingCallId }) =>
          pendingCallId === undefined && source.type === "links" && source.label === data.path,
      ))
  ) {
    if (pendingIndex >= 0) sources.splice(pendingIndex, 1);
    return;
  }

  const resolved = sourceRef(data, accumulator.answer, round);
  if (resolved.type === "article" || resolved.type === "raw") {
    if (pendingIndex >= 0) sources.splice(pendingIndex, 1);
    const index = sources.findIndex(
      ({ source, pendingCallId }) =>
        pendingCallId === undefined &&
        source.label === resolved.label &&
        (source.type === "article" || source.type === "raw"),
    );
    const previous = sources[index]?.source;
    if (previous === undefined) sources.push({ source: resolved });
    else {
      const ranges = resolved.ranges ?? [];
      sources[index] = {
        source: {
          ...previous,
          ranges: ranges.length === 0 ? previous.ranges : [...(previous.ranges ?? []), ...ranges],
          full: previous.full === true || resolved.full === true,
          ...(resolved.outline === true ? { outline: true } : {}),
          ...(resolved.chunks === undefined ? {} : { chunks: resolved.chunks }),
        },
      };
    }
  } else if (pendingIndex < 0) sources.push({ source: resolved });
  else sources[pendingIndex] = { source: resolved };
  accumulator.clearOnNextToken = true;
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

const dispatchReply = (replyId: Uuid, db: Database["Service"]) =>
  Effect.gen(function* () {
    const rows = yield* db.query((d) =>
      d.select({ status: replies.status }).from(replies).where(eq(replies.id, replyId)),
    );
    if (rows[0]?.status !== "running") return;
    yield* ReplyWorkflow.execute({ replyId }, { discard: true });
    yield* db.query((d) =>
      d
        .update(replies)
        .set({
          dispatchedAt: sql`coalesce(${replies.dispatchedAt}, now())`,
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
  readonly settled: (
    userId: Uuid,
    vaultId: Uuid,
    replyId: Uuid,
  ) => Effect.Effect<ReplySnapshot, Forbidden | NotFound>;
  readonly prepareStep: (replyId: Uuid) => Effect.Effect<ReplyStepControl>;
  readonly modelStep: (replyId: Uuid, cursor: number) => Effect.Effect<ReplyStepControl>;
  readonly toolStep: (replyId: Uuid, cursor: number) => Effect.Effect<ReplyStepControl>;
  readonly finalizeStep: (replyId: Uuid, end: ReplyEnd) => Effect.Effect<void>;
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
    const changes = yield* ProgressChanges;
    const withEngine = Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine);

    const readReply = (userId: Uuid, vaultId: Uuid, replyId: Uuid) =>
      db
        .query((d) =>
          d
            .select()
            .from(replies)
            .where(
              and(
                eq(replies.id, replyId),
                eq(replies.vaultId, vaultId),
                eq(replies.userId, userId),
                liveVaultMember(d, userId, vaultId),
              ),
            )
            .limit(1),
        )
        .pipe(Effect.map((rows) => rows[0]));
    const readReplyById = (replyId: Uuid) =>
      db
        .query((d) => d.select().from(replies).where(eq(replies.id, replyId)).limit(1))
        .pipe(Effect.map((rows) => rows[0]));

    const readRestoredReply = (replyId: Uuid) =>
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
          const running = db.query((d) =>
            d.select({ id: replies.id }).from(replies).where(runningUnstoppedReply(replyId)),
          );
          while ((yield* running).length > 0) yield* Effect.sleep("100 millis");
          return Option.none<A>();
        }),
      );

    const readCheckpoint = (row: ReplyRow) =>
      storage.readText(vaultOwner(row.vaultId), checkpointPath(row.id)).pipe(
        Effect.catchTag("StorageFileMissing", () => Effect.succeed(undefined)),
        Effect.flatMap((text) =>
          text === undefined
            ? Effect.succeed(undefined)
            : Effect.orDie(decodeReplyCheckpoint(text)),
        ),
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
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : logger
                .warn("reply_checkpoint_unavailable", { reply_id: row.id })
                .pipe(Effect.as(undefined)),
        ),
      );

    const flushAccumulator = (replyId: Uuid, accumulator: ReplyAccumulator) =>
      updateSnapshot(
        replyId,
        accumulator.answer,
        accumulator.sources.map(({ source, pendingCallId }) =>
          pendingCallId === undefined ? source : { ...source, pending: true },
        ),
      );

    const freezeOutcome = (row: ReplyRow, checkpoint: ReplyCheckpoint | undefined, end: ReplyEnd) =>
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
        if (end.outcome === "stopped") {
          result = { status: "stopped", context_messages: messages, generation };
        } else if (end.outcome === "failed") {
          result = { status: "failed", ...end.failure, context_messages: messages, generation };
        } else {
          if (checkpoint === undefined || generation === null || messages === null) {
            return yield* invariantBroken(row.id, "finished without its generation result");
          }
          result = {
            status: "completed",
            answer: checkpoint.accumulator.answer,
            sources: checkpoint.accumulator.sources.flatMap(({ source, pendingCallId }) =>
              pendingCallId === undefined ? [source] : [],
            ),
            context_messages: messages,
            generation,
          };
        }
        yield* settlement.begin(row.id, result);
      }).pipe(Effect.orDie);

    const freezeStopped = (row: ReplyRow) =>
      Effect.gen(function* () {
        yield* freezeOutcome(row, yield* recoverCheckpoint(row), { outcome: "stopped" });
        return stoppedControl(row.generationCursor);
      });

    const stepFailure = (replyId: Uuid, cursor: number, cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt;
        yield* logger.error("reply_generation_step_failed", {
          reply_id: replyId,
          generation_cursor: cursor,
          ...failureFields(cause),
        });
        const row = yield* readReplyById(replyId);
        if (row === undefined || row.status !== "running") return doneControl(cursor);
        const checkpoint = yield* recoverCheckpoint(row);
        const control = checkpoint?.lastControl;
        if (control !== undefined && terminalControl(control)) {
          yield* freezeOutcome(row, checkpoint, control);
          return control;
        }
        const failed = failedControl(cursor, interruptedFailure(row));
        yield* freezeOutcome(row, checkpoint, failed);
        return failed;
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
    ) =>
      Effect.gen(function* () {
        const recovered = yield* recoverCompletedStep(row, checkpoint, expectedCursor);
        if (recovered !== undefined) return recovered;
        if (checkpoint.cursor !== expectedCursor || row.generationCursor !== expectedCursor) {
          return yield* invariantBroken(
            row.id,
            `cursor mismatch: workflow=${expectedCursor}, database=${row.generationCursor}, checkpoint=${checkpoint.cursor}`,
          );
        }
        if (row.activeGenerationStep !== null) return failedControl(expectedCursor, outcomeUnknown);
        const claimed = yield* db.query((d) =>
          d
            .update(replies)
            .set({
              activeGenerationStep: expectedCursor,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                runningUnstoppedReply(row.id),
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
          return yield* invariantBroken(row.id, `step ${expectedCursor} was not claimable`);
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
              updatedAt: sql`now()`,
            })
            .where(and(eq(replies.id, row.id), eq(replies.status, "running"))),
        );
      });

    const freezeControl = (row: ReplyRow, checkpoint: ReplyCheckpoint, control: ReplyStepControl) =>
      Effect.gen(function* () {
        if (terminalControl(control)) yield* freezeOutcome(row, checkpoint, control);
        return control;
      });

    const resumeStep = (
      replyId: Uuid,
      expectedCursor: number,
      run: (row: ReplyRow, checkpoint: ReplyCheckpoint) => Effect.Effect<ReplyStepControl, unknown>,
    ) =>
      Effect.gen(function* () {
        const row = yield* readReplyById(replyId);
        if (row === undefined) return doneControl(expectedCursor);
        if (row.status !== "running") return doneControl(row.generationCursor);
        if (row.stopRequested) return yield* freezeStopped(row);
        const checkpoint = yield* readCheckpoint(row);
        if (checkpoint === undefined)
          return yield* invariantBroken(replyId, "no generation checkpoint");
        if (terminalControl(checkpoint.lastControl))
          return yield* freezeControl(row, checkpoint, checkpoint.lastControl);
        return yield* run(row, checkpoint);
      }).pipe(Effect.catchCause((cause) => stepFailure(replyId, expectedCursor, cause)));

    const prepareStep = (replyId: Uuid) =>
      Effect.gen(function* () {
        const row = yield* readRestoredReply(replyId);
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
        if (vault === undefined) return yield* invariantBroken(row.id, "no vault");
        const queryState = yield* query.prepareExecution(
          row.userId,
          row.vaultId,
          {
            question: transcript.question,
            typedQuestion: transcript.typedQuestion,
            mode: accepted.mode,
            vaultLabel: vault.name,
            originPath: accepted.command.origin_path,
            originScope: accepted.command.origin_scope,
          },
          transcript.prior,
        );
        const control = readyControl(row.generationCursor);
        const checkpoint: ReplyCheckpoint = {
          version: checkpointVersion,
          cursor: row.generationCursor,
          query: queryState,
          accumulator: { answer: "", sources: [], clearOnNextToken: false },
          pendingTools: [],
          nextToolIndex: 0,
          lastControl: control,
        };
        yield* updateSnapshot(replyId, "", []);
        yield* writeCheckpoint(row, checkpoint);
        return control;
      }).pipe(Effect.catchCause((cause) => stepFailure(replyId, 0, cause)));

    const modelStep = (replyId: Uuid, expectedCursor: number) =>
      resumeStep(replyId, expectedCursor, (row, checkpoint) =>
        Effect.gen(function* () {
          const claimed = yield* claimExternalStep(row, checkpoint, expectedCursor);
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
            yield* freezeOutcome(row, checkpoint, { outcome: "stopped" });
            return stoppedControl(expectedCursor);
          }
          const outcome = attempt.value;
          let control: ReplyStepControl;
          let pendingTools: readonly QueryPreparedToolCallType[] = [];
          if (outcome.kind === "tool_calls") {
            for (const { id, pendingSource } of outcome.toolCalls) {
              if (pendingSource === undefined) continue;
              accumulator.sources.push({
                source: sourceRef(
                  pendingSource,
                  accumulator.answer,
                  checkpoint.query.trace.llmRounds,
                ),
                pendingCallId: id,
              });
              accumulator.clearOnNextToken = true;
            }
            pendingTools = outcome.toolCalls;
            control = { cursor: expectedCursor + 1, outcome: "tool_calls" };
          } else if (outcome.kind === "retryable") {
            accumulator.clearOnNextToken = true;
            control = readyControl(expectedCursor + 1);
          } else if (outcome.kind === "done") control = doneControl(expectedCursor + 1);
          else control = failedControl(expectedCursor + 1, generationFailed(outcome.error));
          yield* flushAccumulator(replyId, accumulator);
          const nextCheckpoint: ReplyCheckpoint = {
            ...checkpoint,
            cursor: expectedCursor + 1,
            pendingTools,
            nextToolIndex: 0,
            lastControl: control,
          };
          if (terminalControl(control)) {
            yield* freezeOutcome(row, nextCheckpoint, control);
            const saved = yield* writeCheckpoint(row, nextCheckpoint).pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : logger
                      .warn("reply_terminal_checkpoint_unavailable", { reply_id: row.id })
                      .pipe(Effect.as(false)),
              ),
            );
            if (!saved) yield* query.finalizeExecution(nextCheckpoint.query);
          } else yield* commitExternalStep(row, nextCheckpoint);
          return control;
        }),
      );

    const toolStep = (replyId: Uuid, expectedCursor: number) =>
      resumeStep(replyId, expectedCursor, (row, checkpoint) =>
        Effect.gen(function* () {
          const toolCall = checkpoint.pendingTools[checkpoint.nextToolIndex];
          if (toolCall === undefined)
            return yield* invariantBroken(
              replyId,
              `no pending tool at ${checkpoint.nextToolIndex}`,
            );
          const claimed = yield* claimExternalStep(row, checkpoint, expectedCursor);
          if (claimed !== undefined) return yield* freezeControl(row, checkpoint, claimed);
          const accumulator = checkpoint.accumulator;
          const attempt = yield* untilStopped(replyId, query.runTool(checkpoint.query, toolCall));
          if (Option.isNone(attempt)) {
            yield* freezeOutcome(row, checkpoint, { outcome: "stopped" });
            return stoppedControl(expectedCursor);
          }
          resolveSource(accumulator, toolCall.id, attempt.value, checkpoint.query.trace.llmRounds);
          yield* flushAccumulator(replyId, accumulator);
          const nextToolIndex = checkpoint.nextToolIndex + 1;
          const remaining = checkpoint.pendingTools.length - nextToolIndex;
          const control: ReplyStepControl =
            remaining > 0
              ? { cursor: expectedCursor + 1, outcome: "tool_calls" }
              : readyControl(expectedCursor + 1);
          const nextCheckpoint: ReplyCheckpoint = {
            ...checkpoint,
            cursor: expectedCursor + 1,
            pendingTools: remaining > 0 ? checkpoint.pendingTools : [],
            nextToolIndex: remaining > 0 ? nextToolIndex : 0,
            lastControl: control,
          };
          yield* commitExternalStep(row, nextCheckpoint);
          return control;
        }),
      );

    const deferFailure = (event: string, replyId: Uuid) => (cause: Cause.Cause<unknown>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : logger.warn(event, { reply_id: replyId, ...failureFields(cause) });

    const publishBestEffort = (replyId: Uuid) =>
      settlement
        .publish(replyId)
        .pipe(Effect.asVoid, Effect.catchCause(deferFailure("reply_settlement_deferred", replyId)));

    const finalizeStep = (replyId: Uuid, end: ReplyEnd) =>
      Effect.gen(function* () {
        const row = yield* readReplyById(replyId);
        if (row === undefined || row.status === "admitting") return;
        const checkpoint = yield* recoverCheckpoint(row);
        if (row.status === "running") yield* freezeOutcome(row, checkpoint, end);
        yield* publishBestEffort(replyId);
        if (checkpoint === undefined) return;
        yield* query.finalizeExecution(checkpoint.query);
        const settled = yield* readReplyById(replyId);
        if (settled !== undefined && !isReplyPending(settled.status))
          yield* storage.deletePath(vaultOwner(row.vaultId), checkpointPath(replyId));
      }).pipe(Effect.catchCause(deferFailure("reply_finalization_deferred", replyId)));

    const dispatchBestEffort = (replyId: Uuid) =>
      dispatchReply(replyId, db).pipe(
        withEngine,
        Effect.catchCause(deferFailure("reply_dispatch_deferred", replyId)),
      );

    const acceptAndDispatch = (accept: Effect.Effect<CreateReplyResponse, ReplyAdmissionError>) =>
      Effect.gen(function* () {
        const response = yield* accept.pipe(Effect.mapError(requestError));
        yield* dispatchBestEffort(response.reply_id);
        return response;
      });

    const reconcileReply = (initial: ReplyRow) =>
      Effect.gen(function* () {
        const row = yield* readRestoredReply(initial.id);
        if (row === undefined || !isReplyPending(row.status)) return;
        if (row.status === "admitting") {
          yield* admission.admit(row.id);
          yield* dispatchBestEffort(row.id);
        } else if (row.status === "settling") {
          yield* publishBestEffort(row.id);
        } else if (row.dispatchedAt === null) {
          yield* dispatchBestEffort(row.id);
        } else {
          const executionId = yield* ReplyWorkflow.executionId({ replyId: row.id });
          const state = yield* ReplyWorkflow.poll(executionId).pipe(withEngine);
          if (Option.isNone(state)) {
            yield* dispatchBestEffort(row.id);
          } else if (state.value._tag === "Suspended") {
            yield* ReplyWorkflow.resume(executionId).pipe(withEngine);
          } else {
            const checkpoint = yield* recoverCheckpoint(row);
            const control = checkpoint?.lastControl;
            yield* freezeOutcome(
              row,
              checkpoint,
              control !== undefined && terminalControl(control)
                ? control
                : { outcome: "failed", failure: interruptedFailure(row) },
            );
            yield* publishBestEffort(row.id);
          }
        }
      }).pipe(Effect.catchCause(deferFailure("reply_reconciliation_deferred", initial.id)));

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
          if ((yield* readReply(userId, vaultId, replyId)) === undefined)
            return yield* replyNotFound();
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
          const member = yield* access.requireMember(userId, vaultId);
          const read = readReply(userId, vaultId, replyId);
          if ((yield* read) === undefined) return yield* replyNotFound();
          return snapshotSse(
            replyId,
            changes.subscribe("replies", member, replyId),
            read,
            (row) => ({
              version: row.version,
              data: () => encodeReplySnapshot(replySnapshot(row)),
              terminal: !isReplyPending(row.status),
            }),
          );
        }),
      settled: (userId, vaultId, replyId) =>
        Effect.gen(function* () {
          const member = yield* access.requireMember(userId, vaultId);
          const wakes = yield* changes.subscribe("replies", member, replyId);
          const read = readReply(userId, vaultId, replyId);
          const waitForChange = Queue.take(wakes).pipe(
            Effect.delay("100 millis"),
            Effect.timeoutOption("30 seconds"),
          );
          while (true) {
            const row = yield* read;
            if (row === undefined) return yield* replyNotFound();
            if (!isReplyPending(row.status)) return replySnapshot(row);
            yield* waitForChange;
          }
        }).pipe(Effect.scoped),
      prepareStep,
      modelStep,
      toolStep,
      finalizeStep,
      reconcileOnce: () =>
        Effect.gen(function* () {
          const pending = inArray(replies.status, SessionActivity.fields.status.literals);
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
    yield* Activity.make({
      name: "reply-finalize",
      success: Schema.Void,
      execute: service.finalizeStep(payload.replyId, control),
    });
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
