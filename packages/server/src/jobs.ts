import { compileIntents, Database, pipelineRuns } from "@great-minds/database";
import {
  Forbidden,
  NotFound,
  type JobListQuery,
  type JobPage,
  type JobProgressSnapshot,
  type JobResponse,
  type JobSseEvent,
  type Uuid,
} from "@great-minds/domain";
import { and, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer, Option, Stream } from "effect";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";

import { cancelCompileWorkflow } from "./compile-intents.ts";
import { AppConfig } from "./config.ts";
import { FileIngestBatches } from "./file-ingest-batches.ts";
import { jobResponse } from "./job-response.ts";
import { pageEnvelope, oneTotal } from "./pagination.ts";
import { PipelineRunsService } from "./pipeline-runs.ts";
import { StagedFileIngestWorkflow } from "./staged-file-ingest-workflow.ts";
import { VaultAccessService } from "./vaults.ts";
import { workflowExecutionId } from "./workflow-engine.ts";

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

const progressSnapshot = (row: typeof pipelineRuns.$inferSelect): JobProgressSnapshot => ({
  id: row.id as Uuid,
  vault_id: row.vaultId as Uuid,
  trigger: row.trigger as JobProgressSnapshot["trigger"],
  job_status: row.status as JobProgressSnapshot["job_status"],
  phase: row.currentPhase,
  phase_status: row.phaseStatus,
  steps: row.progressSteps as JobProgressSnapshot["steps"],
  ...(row.error === null || row.error.length === 0 ? {} : { error: row.error }),
  updated_at: row.updatedAt.toISOString(),
  completed_at: row.completedAt?.toISOString() ?? null,
});

const sse = (event: string, data: unknown): JobSseEvent => ({
  event,
  data: typeof data === "string" ? data : JSON.stringify(data),
});

export const jobSseStream = <A>(events: AsyncIterable<A>) =>
  Stream.fromAsyncIterable(events, (cause) => cause).pipe(
    Stream.catch((cause) => Stream.fromEffect(Effect.die(cause))),
  );

type JobsServiceShape = {
  readonly requestCompile: (
    userId: Uuid,
    vaultId: Uuid,
    jobId: Uuid,
  ) => Effect.Effect<JobResponse, Forbidden>;
  readonly cancelCompile: (
    userId: Uuid,
    vaultId: Uuid,
    runId: Uuid,
  ) => Effect.Effect<void, Forbidden>;
  readonly list: (
    userId: Uuid,
    vaultId: Uuid,
    query: JobListQuery,
  ) => Effect.Effect<JobPage, Forbidden>;
  readonly get: (
    userId: Uuid,
    vaultId: Uuid,
    jobId: Uuid,
  ) => Effect.Effect<JobResponse, Forbidden | NotFound>;
  readonly stream: (
    userId: Uuid,
    vaultId: Uuid,
    jobId: Uuid,
  ) => Effect.Effect<Stream.Stream<JobSseEvent>, Forbidden | NotFound>;
};

export class JobsService extends Context.Service<JobsService, JobsServiceShape>()(
  "@great-minds/server/JobsService",
) {}

export const JobsServiceLive = Layer.effect(
  JobsService,
  Effect.gen(function* () {
    const db = yield* Database;
    const config = yield* AppConfig;
    const access = yield* VaultAccessService;
    const pipeline = yield* PipelineRunsService;
    const fileIngestBatches = yield* FileIngestBatches;
    const workflowEngine = yield* WorkflowEngine.WorkflowEngine;
    const pollIntervalMs = Option.isSome(config.goldensClock) ? 1 : 100;

    const readRun = (vaultId: Uuid, jobId: Uuid) =>
      db.query((d) => d
        .select()
        .from(pipelineRuns)
        .where(and(eq(pipelineRuns.id, jobId), eq(pipelineRuns.vaultId, vaultId)))
        .limit(1))
        .pipe(Effect.map((rows) => rows[0]));

    const requestCompile = (vaultId: Uuid, jobId: Uuid) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const insertedRuns = yield* tx
              .insert(pipelineRuns)
              .values({
                id: jobId,
                vaultId,
                trigger: "manual",
                status: "pending",
                currentPhase: "",
                phaseStatus: "",
                progressSteps: [],
              })
              .onConflictDoNothing({ target: pipelineRuns.id })
              .returning({ id: pipelineRuns.id });
            const insertedRun = insertedRuns.length === 1;

            const intentRows = yield* tx
              .insert(compileIntents)
              .values({ vaultId, pipelineRunId: jobId })
              .onConflictDoUpdate({
                target: compileIntents.vaultId,
                targetWhere: sql`${compileIntents.dispatchedAt} IS NULL`,
                set: { vaultId: sql`compile_intents.vault_id` },
              })
              .returning({ id: compileIntents.id, pipelineRunId: compileIntents.pipelineRunId });
            const intent = intentRows[0];
            if (intent === undefined) {
              throw new Error("compile intent upsert returned no row");
            }

            const runId = (intent.pipelineRunId ?? jobId) as Uuid;
            if (intent.pipelineRunId === null) {
              yield* tx
                .update(compileIntents)
                .set({ pipelineRunId: jobId })
                .where(eq(compileIntents.id, intent.id));
              yield* tx
                .update(pipelineRuns)
                .set({ compileIntentId: intent.id, updatedAt: sql`now()` })
                .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.vaultId, vaultId)));
            }
            if (insertedRun && runId !== jobId) {
              yield* tx.delete(pipelineRuns).where(eq(pipelineRuns.id, jobId));
            }
            const rows = yield* tx
              .select()
              .from(pipelineRuns)
              .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.vaultId, vaultId)))
              .limit(1);
            const run = rows[0];
            if (run === undefined) {
              throw new Error(`compile pipeline run missing for vault ${vaultId}, job ${jobId}`);
            }
            return jobResponse(run);
          }),
        );

    return {
      requestCompile: (userId, vaultId, jobId) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          return yield* requestCompile(vaultId, jobId);
        }),
      cancelCompile: (userId, vaultId, runId) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          const rows = yield* db.query((d) => d
            .select({
              trigger: pipelineRuns.trigger,
              activeTaskId: pipelineRuns.activeTaskId,
              activeTaskType: pipelineRuns.activeTaskType,
            })
            .from(pipelineRuns)
            .where(
              and(
                eq(pipelineRuns.id, runId),
                eq(pipelineRuns.vaultId, vaultId),
                inArray(pipelineRuns.status, ["pending", "running"]),
              ),
            )
            .limit(1));
          const run = rows[0];
          if (run === undefined) return;
          if (run.activeTaskType === "compile" && run.activeTaskId !== null) {
            yield* cancelCompileWorkflow(runId, run.activeTaskId).pipe(
              Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine),
              Effect.provideService(PipelineRunsService, pipeline),
            );
            return;
          }
          yield* pipeline.cancel(runId);
          if (run.activeTaskType === "staged_file_ingest" && run.activeTaskId !== null) {
            yield* workflowEngine.interruptUnsafe(
              StagedFileIngestWorkflow,
              workflowExecutionId(StagedFileIngestWorkflow._tag, run.activeTaskId),
            );
          }
          if (run.trigger === "staged_files") {
            yield* fileIngestBatches.cancel(runId);
          }
        }),
      list: (userId, vaultId, query) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const conditions: SQL[] = [eq(pipelineRuns.vaultId, vaultId)];
          if (query.status === "active") {
            conditions.push(inArray(pipelineRuns.status, ["pending", "running"]));
          } else if (query.status !== undefined) {
            conditions.push(eq(pipelineRuns.status, query.status));
          }
          const where = and(...conditions);
          const totals = yield* db.query((d) => d
            .select({ total: count() })
            .from(pipelineRuns)
            .where(where));
          const rows = yield* db.query((d) => d
            .select()
            .from(pipelineRuns)
            .where(where)
            .orderBy(desc(pipelineRuns.createdAt))
            .limit(query.limit)
            .offset(query.offset));
          return pageEnvelope(rows.map(jobResponse), query, oneTotal(totals));
        }),
      get: (userId, vaultId, jobId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const run = yield* readRun(vaultId, jobId);
          if (run === undefined) return yield* new NotFound({ detail: "Job not found" });
          return jobResponse(run);
        }),
      stream: (userId, vaultId, jobId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const initial = yield* readRun(vaultId, jobId);
          if (initial === undefined) return yield* new NotFound({ detail: "Job not found" });

          async function* events() {
            yield sse("connected", { id: jobId });
            let previous = "";
            let heartbeatAt = Date.now() + 30_000;
            while (true) {
              const row = await Effect.runPromise(readRun(vaultId, jobId));
              if (row !== undefined) {
                const snapshot = progressSnapshot(row);
                const encoded = JSON.stringify(snapshot);
                if (encoded !== previous) {
                  previous = encoded;
                  yield sse("message", encoded);
                  if (terminalStatuses.has(snapshot.job_status)) {
                    yield sse("done", { id: jobId });
                    return;
                  }
                }
              }
              if (Date.now() >= heartbeatAt) {
                // HttpApi's SSE encoder renders an empty message as a blank keepalive frame.
                yield sse("message", "");
                heartbeatAt = Date.now() + 30_000;
              }
              await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            }
          }

          // The polling state machine stays in one async generator so snapshot dedup,
          // terminal closure, and the independent heartbeat deadline remain atomic.
          // Its captured DB service needs no environment, but runPromise is outside the
          // server runtime's supervision; an Effect-native stream is a later cleanup.
          return jobSseStream(events());
        }),
    } satisfies JobsServiceShape;
  }),
);
