import {
  Database,
  pipelineRuns,
  urlIngestRequests,
} from "@great-minds/database";
import {
  BadRequest,
  Forbidden,
  type JobResponse,
  NotFound,
  type Uuid,
} from "@great-minds/domain";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer } from "effect";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";

import { AppConfig } from "./config.ts";
import { jobResponse } from "./job-response.ts";
import { StructuredLogger } from "./logging.ts";
import { progressSteps } from "./pipeline-runs.ts";
import { type CanonicalSourceUrl, parseCanonicalSourceUrl } from "./source-identity.ts";
import { UrlIngestWorkflow, URL_INGEST_STEP_LABELS } from "./url-ingest-workflow.ts";
import { VaultAccessService } from "./vaults.ts";

export const URL_INGEST_TASK_TYPE = "url_ingest";

type UrlIngestServiceShape = {
  readonly start: (
    userId: Uuid,
    vaultId: Uuid,
    input: { readonly jobId: Uuid; readonly url: CanonicalSourceUrl; readonly origin?: string },
  ) => Effect.Effect<JobResponse, BadRequest | Forbidden>;
  readonly retry: (
    userId: Uuid,
    vaultId: Uuid,
    previousRunId: Uuid,
    nextRunId: Uuid,
  ) => Effect.Effect<JobResponse, BadRequest | Forbidden | NotFound>;
  readonly reconcileOnce: () => Effect.Effect<number>;
};

export class UrlIngestService extends Context.Service<
  UrlIngestService,
  UrlIngestServiceShape
>()("@great-minds/server/UrlIngestService") {}

type PersistedRequest = {
  readonly id: Uuid;
  readonly vaultId: Uuid;
  readonly createdBy: Uuid;
  readonly canonicalUrl: string;
  readonly origin: string | null;
  readonly dispatchedAt: Date | null;
};

export const UrlIngestServiceLive = Layer.effect(
  UrlIngestService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;
    const workflowEngine = yield* WorkflowEngine.WorkflowEngine;
    const logger = yield* StructuredLogger;
    const config = yield* AppConfig;

    const dispatch = (request: PersistedRequest) =>
      Effect.gen(function* () {
        yield* UrlIngestWorkflow.execute(
          { pipelineRunId: request.id },
          { discard: true },
        ).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine));
        yield* db.query((d) => d
          .update(urlIngestRequests)
          .set({
            dispatchedAt: sql`coalesce(${urlIngestRequests.dispatchedAt}, now())`,
            dispatchedTaskId: request.id,
            updatedAt: sql`now()`,
          })
          .where(eq(urlIngestRequests.id, request.id)));
      });

    const dispatchBestEffort = (request: PersistedRequest) =>
      dispatch(request).pipe(
        Effect.catchCause((cause) =>
          logger.warn("url_ingest_dispatch_deferred", {
            pipeline_run_id: request.id,
            vault_id: request.vaultId,
            error_message: Cause.pretty(cause),
          }),
        ),
      );

    const createOperation = (
      userId: Uuid,
      vaultId: Uuid,
      jobId: Uuid,
      canonicalUrl: CanonicalSourceUrl,
      origin: string | undefined,
    ) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const inserted = yield* tx
            .insert(pipelineRuns)
            .values({
              id: jobId,
              vaultId,
              trigger: "url",
              status: "pending",
              currentPhase: "source_ingest",
              phaseStatus: "started",
              progressSteps: progressSteps(URL_INGEST_STEP_LABELS, "fetch_url", {
                counts: { fetch_url: [0, 1] },
              }),
              ingestTaskId: jobId,
              activeTaskId: jobId,
              activeTaskType: URL_INGEST_TASK_TYPE,
            })
            .onConflictDoNothing({ target: pipelineRuns.id })
            .returning({ id: pipelineRuns.id });

          if (inserted.length === 1) {
            yield* tx.insert(urlIngestRequests).values({
              id: jobId,
              createdBy: userId,
              canonicalUrl,
              origin,
            });
          }

          const requestRows = yield* tx
            .select({
              id: urlIngestRequests.id,
              vaultId: pipelineRuns.vaultId,
              createdBy: urlIngestRequests.createdBy,
              canonicalUrl: urlIngestRequests.canonicalUrl,
              origin: urlIngestRequests.origin,
              dispatchedAt: urlIngestRequests.dispatchedAt,
            })
            .from(urlIngestRequests)
            .innerJoin(pipelineRuns, eq(pipelineRuns.id, urlIngestRequests.id))
            .where(eq(urlIngestRequests.id, jobId))
            .limit(1);
          const request = requestRows[0] as PersistedRequest | undefined;
          if (
            request === undefined ||
            request.vaultId !== vaultId ||
            request.createdBy !== userId ||
            request.canonicalUrl !== canonicalUrl ||
            request.origin !== (origin ?? null)
          ) {
            return yield* new BadRequest({ detail: "Job ID is already in use" });
          }
          const runRows = yield* tx
            .select()
            .from(pipelineRuns)
            .where(and(eq(pipelineRuns.id, jobId), eq(pipelineRuns.vaultId, vaultId)))
            .limit(1);
          const run = runRows[0];
          if (run === undefined) throw new Error(`URL pipeline run ${jobId} not found`);
          return { request, response: jobResponse(run) };
        }),
      );

    const start = (
      userId: Uuid,
      vaultId: Uuid,
      input: { readonly jobId: Uuid; readonly url: CanonicalSourceUrl; readonly origin?: string },
    ) =>
      Effect.gen(function* () {
        yield* access.requireOwner(userId, vaultId);
        const accepted = yield* createOperation(
          userId,
          vaultId,
          input.jobId,
          input.url,
          input.origin,
        );
        if (accepted.request.dispatchedAt === null) {
          yield* dispatchBestEffort(accepted.request);
        }
        return accepted.response;
      });

    return {
      start,
      retry: (userId, vaultId, previousRunId, nextRunId) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          if (previousRunId === nextRunId) {
            return yield* new BadRequest({ detail: "Retry requires a new job ID" });
          }
          const rows = yield* db.query((d) => d
            .select({
              request: {
                id: urlIngestRequests.id,
                createdBy: urlIngestRequests.createdBy,
                canonicalUrl: urlIngestRequests.canonicalUrl,
                origin: urlIngestRequests.origin,
              },
              run: {
                vaultId: pipelineRuns.vaultId,
                status: pipelineRuns.status,
              },
            })
            .from(urlIngestRequests)
            .innerJoin(pipelineRuns, eq(pipelineRuns.id, urlIngestRequests.id))
            .where(eq(urlIngestRequests.id, previousRunId))
            .limit(1));
          const previous = rows[0];
          if (previous === undefined || previous.run.vaultId !== vaultId) {
            return yield* new NotFound({ detail: "URL ingest job not found" });
          }
          if (previous.run.status !== "failed" && previous.run.status !== "cancelled") {
            return yield* new BadRequest({ detail: "Only failed or cancelled URL ingests can retry" });
          }
          const canonicalUrl = yield* parseCanonicalSourceUrl(previous.request.canonicalUrl).pipe(
            Effect.orDie,
          );
          return yield* start(userId, vaultId, {
            jobId: nextRunId,
            url: canonicalUrl,
            ...(previous.request.origin === null ? {} : { origin: previous.request.origin }),
          });
        }),
      reconcileOnce: () =>
        Effect.gen(function* () {
          const rows = yield* db.query((d) => d
            .select({
              id: urlIngestRequests.id,
              vaultId: pipelineRuns.vaultId,
              createdBy: urlIngestRequests.createdBy,
              canonicalUrl: urlIngestRequests.canonicalUrl,
              origin: urlIngestRequests.origin,
              dispatchedAt: urlIngestRequests.dispatchedAt,
            })
            .from(urlIngestRequests)
            .innerJoin(pipelineRuns, eq(pipelineRuns.id, urlIngestRequests.id))
            .where(
              and(
                isNull(urlIngestRequests.dispatchedAt),
                inArray(pipelineRuns.status, ["pending", "running"]),
              ),
            )
            .orderBy(asc(urlIngestRequests.createdAt))
            .limit(100));
          yield* Effect.forEach(
            rows as PersistedRequest[],
            dispatchBestEffort,
            { concurrency: config.pipelineConcurrency },
          );
          return rows.length;
        }),
    } satisfies UrlIngestServiceShape;
  }),
);

export const UrlIngestReconcilerLoopLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* UrlIngestService;
    const logger = yield* StructuredLogger;
    const tick = service.reconcileOnce().pipe(
      Effect.catchCause((cause) =>
        logger.warn("url_ingest_reconciler_tick_failed", {
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
