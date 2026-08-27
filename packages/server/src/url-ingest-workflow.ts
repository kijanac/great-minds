import { Database, pipelineRuns, urlIngestRequests } from "@great-minds/database";
import { BadRequest, Uuid } from "@great-minds/domain";
import { eq } from "drizzle-orm";
import { Cause, Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import * as Workflow from "effect/unstable/workflow/Workflow";

import { causeDetails, formatError } from "./error-details.ts";
import { IngestService } from "./ingest.ts";
import { StructuredLogger } from "./logging.ts";
import { PipelineRunsService, progressSteps } from "./pipeline-runs.ts";
import { parseCanonicalSourceUrl } from "./source-identity.ts";

export const URL_INGEST_STEP_LABELS = {
  fetch_url: "Fetching source URL",
  convert_document: "Converting source document",
  index_document: "Indexing source document",
} as const;

export class UrlIngestWorkflowError extends Schema.TaggedErrorClass<UrlIngestWorkflowError>()(
  "UrlIngestWorkflowError",
  { message: Schema.String },
) {}

export const UrlIngestWorkflow = Workflow.make("UrlIngest", {
  payload: { pipelineRunId: Uuid },
  idempotencyKey: ({ pipelineRunId }) => pipelineRunId,
  success: Schema.Void,
  error: UrlIngestWorkflowError,
});

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const reason = cause.reasons.find(Cause.isFailReason);
  const error = reason?.error;
  return error instanceof BadRequest ? error.detail : formatError(causeDetails(cause));
};

export const UrlIngestWorkflowLive = UrlIngestWorkflow.toLayer((payload) =>
  Activity.make({
    name: "url-ingest-persist",
    success: Schema.Void,
    error: UrlIngestWorkflowError,
    execute: Effect.gen(function* () {
      const db = yield* Database;
      const ingest = yield* IngestService;
      const pipeline = yield* PipelineRunsService;
      const runId = payload.pipelineRunId;
      const rows = yield* db.query((d) => d
        .select({
          vaultId: pipelineRuns.vaultId,
          canonicalUrl: urlIngestRequests.canonicalUrl,
          origin: urlIngestRequests.origin,
        })
        .from(urlIngestRequests)
        .innerJoin(pipelineRuns, eq(pipelineRuns.id, urlIngestRequests.id))
        .where(eq(urlIngestRequests.id, runId))
        .limit(1));
      const request = rows[0];
      if (request === undefined) {
        throw new Error(`URL ingest request ${runId} not found`);
      }
      if (!(yield* pipeline.isActive(runId))) return yield* Effect.interrupt;

      yield* pipeline.updateProgress(
        runId,
        "source_ingest",
        "started",
        progressSteps(URL_INGEST_STEP_LABELS, "fetch_url", {
          counts: { fetch_url: [0, 1] },
        }),
      );
      const canonicalUrl = yield* parseCanonicalSourceUrl(request.canonicalUrl).pipe(Effect.orDie);
      yield* ingest.ingestUrl(
        request.vaultId as Uuid,
        canonicalUrl,
        request.origin ?? undefined,
        runId,
      );
      yield* pipeline.updateProgress(
        runId,
        "source_ingest",
        "completed",
        progressSteps(URL_INGEST_STEP_LABELS, "index_document", {
          completed: new Set(Object.keys(URL_INGEST_STEP_LABELS)),
          counts: { fetch_url: [1, 1] },
        }),
      );
    }).pipe(
      Effect.catchCause((cause) => {
        if (cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason)) {
          return Effect.interrupt;
        }
        const message = failureMessage(cause);
        return Effect.gen(function* () {
          const pipeline = yield* PipelineRunsService;
          const logger = yield* StructuredLogger;
          yield* pipeline.updateProgress(
            payload.pipelineRunId,
            "source_ingest",
            "failed",
            progressSteps(URL_INGEST_STEP_LABELS, "fetch_url", {
              failed: new Set(["fetch_url"]),
              details: { fetch_url: message },
            }),
            message,
          );
          yield* logger.error("url_ingest_workflow_failed", {
            pipeline_run_id: payload.pipelineRunId,
            error_message: message,
          });
          return yield* new UrlIngestWorkflowError({ message });
        });
      }),
    ),
  }),
);
