import { Database, pipelineRuns } from "@great-minds/database";
import {
  Forbidden,
  NotFound,
  ServiceUnavailable,
  type JobListQuery,
  type JobPage,
  type JobProgressSnapshot,
  JobProgressSnapshot as JobProgressSnapshotSchema,
  type JobResponse,
  type JobSseEvent,
  type Uuid,
} from "@great-minds/domain";
import { and, count, desc, eq, inArray, type SQL } from "drizzle-orm";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";

import { cancelCompileWorkflow, linkRunToIntent, queueCompile } from "./compile-intents.ts";
import { AppConfig, missingModelKey, notConfiguredDetail } from "./config.ts";
import { FileIngestBatches } from "./file-ingest-batches.ts";
import { jobResponse } from "./job-response.ts";
import { pageEnvelope, oneTotal } from "./pagination.ts";
import { PipelineRunsService } from "./pipeline-runs.ts";
import { pollingSse } from "./polling-sse.ts";
import { runTrack } from "./run-track.ts";
import { StagedFileIngestWorkflow } from "./staged-file-ingest-workflow.ts";
import { UrlIngestWorkflow } from "./url-ingest-workflow.ts";
import { VaultAccessService } from "./vaults.ts";

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

const progressSnapshot = (row: typeof pipelineRuns.$inferSelect): JobProgressSnapshot => ({
  id: row.id,
  vault_id: row.vaultId,
  trigger: row.trigger,
  job_status: row.status,
  phase: row.currentPhase,
  phase_status: row.phaseStatus,
  stages: row.stages,
  warnings: row.warnings,
  track: runTrack(row),
  outcome: row.outcome,
  ...(row.error ? { error: row.error } : {}),
  created_at: row.createdAt,
  updated_at: row.updatedAt,
  completed_at: row.completedAt,
});

const encodeProgressSnapshot = Schema.encodeSync(Schema.fromJsonString(JobProgressSnapshotSchema));

type JobsServiceShape = {
  readonly requestCompile: (
    userId: Uuid,
    vaultId: Uuid,
    jobId: Uuid,
  ) => Effect.Effect<JobResponse, Forbidden | ServiceUnavailable>;
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
    const pollIntervalMs = 100;

    const readRun = (vaultId: Uuid, jobId: Uuid) =>
      db
        .query((d) =>
          d
            .select()
            .from(pipelineRuns)
            .where(and(eq(pipelineRuns.id, jobId), eq(pipelineRuns.vaultId, vaultId)))
            .limit(1),
        )
        .pipe(Effect.map((rows) => rows[0]));

    const requestCompile = (vaultId: Uuid, jobId: Uuid) =>
      db.transaction((tx) =>
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
            })
            .onConflictDoNothing({ target: pipelineRuns.id })
            .returning({ id: pipelineRuns.id });
          const insertedRun = insertedRuns.length === 1;

          const intent = yield* queueCompile(tx, vaultId, jobId);
          const runId = intent.runId ?? jobId;
          yield* linkRunToIntent(tx, runId, intent.id);
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
          const missing = [
            config.extractModel,
            config.mapModel,
            config.reduceModel,
            config.renderModel,
            config.embeddingModel,
          ]
            .map((model) => missingModelKey(config, model))
            .find((key) => key !== undefined);
          if (missing !== undefined)
            return yield* new ServiceUnavailable({ detail: notConfiguredDetail(missing) });
          return yield* requestCompile(vaultId, jobId);
        }),
      cancelCompile: (userId, vaultId, runId) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          const rows = yield* db.query((d) =>
            d
              .select({
                trigger: pipelineRuns.trigger,
                compileIntentId: pipelineRuns.compileIntentId,
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
              .limit(1),
          );
          const run = rows[0];
          if (run === undefined) return;
          if (run.compileIntentId !== null) {
            yield* cancelCompileWorkflow(run.compileIntentId).pipe(
              Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine),
              Effect.provideService(PipelineRunsService, pipeline),
            );
            return;
          }
          yield* pipeline.cancel(runId);
          if (run.activeTaskType === "staged_file_ingest" && run.activeTaskId !== null) {
            yield* workflowEngine.interruptUnsafe(
              StagedFileIngestWorkflow,
              yield* StagedFileIngestWorkflow.executionId({
                vaultId,
                batchId: run.activeTaskId,
                pipelineRunId: run.activeTaskId,
                files: [],
              }),
            );
          }
          if (run.activeTaskType === "url_ingest" && run.activeTaskId !== null) {
            yield* workflowEngine.interruptUnsafe(
              UrlIngestWorkflow,
              yield* UrlIngestWorkflow.executionId({ pipelineRunId: run.activeTaskId }),
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
          const totals = yield* db.query((d) =>
            d.select({ total: count() }).from(pipelineRuns).where(where),
          );
          const rows = yield* db.query((d) =>
            d
              .select()
              .from(pipelineRuns)
              .where(where)
              .orderBy(desc(pipelineRuns.createdAt))
              .limit(query.limit)
              .offset(query.offset),
          );
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

          const visibleRun = Effect.gen(function* () {
            yield* access.requireMember(userId, vaultId);
            return yield* readRun(vaultId, jobId);
          }).pipe(Effect.catchTag("Forbidden", () => Effect.succeed(undefined)));

          return pollingSse(
            jobId,
            visibleRun,
            (row) => {
              const snapshot = progressSnapshot(row);
              const data = encodeProgressSnapshot(snapshot);
              return { version: data, data, terminal: terminalStatuses.has(snapshot.job_status) };
            },
            pollIntervalMs,
          );
        }),
    } satisfies JobsServiceShape;
  }),
);
