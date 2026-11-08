import {
  compileIntents,
  Database,
  fileIngestBatches,
  pipelineRuns,
  urlIngestRequests,
} from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import type * as Workflow from "effect/workflow/Workflow";

import { backgroundLoop } from "./background-loop.ts";
import { CompileWorkflow } from "./compile-intents.ts";
import { causeDetails, formatError } from "./error-details.ts";
import { StructuredLogger } from "./logging.ts";
import { PipelineRunsService } from "./pipeline-runs.ts";
import { StagedFileIngestWorkflow } from "./staged-file-ingest-workflow.ts";
import { UrlIngestWorkflow } from "./url-ingest-workflow.ts";

export const LOST_RUN_ERROR =
  "This run was lost: the record of its work is missing, so it cannot continue. Start it again.";

type ActiveRun = {
  readonly id: Uuid;
  readonly vaultId: Uuid;
  readonly activeTaskId: Uuid | null;
  readonly activeTaskType: string | null;
  readonly compileIntentId: Uuid | null;
};

const pollTask = (run: ActiveRun & { readonly activeTaskId: Uuid }) => {
  if (run.activeTaskType === "compile")
    return CompileWorkflow.executionId({
      intentId: run.activeTaskId,
      vaultId: run.vaultId,
      pipelineRunId: run.id,
    }).pipe(Effect.flatMap((executionId) => CompileWorkflow.poll(executionId)));
  if (run.activeTaskType === "staged_file_ingest")
    return StagedFileIngestWorkflow.executionId({
      vaultId: run.vaultId,
      batchId: run.activeTaskId,
      pipelineRunId: run.activeTaskId,
      files: [],
    }).pipe(Effect.flatMap((executionId) => StagedFileIngestWorkflow.poll(executionId)));
  if (run.activeTaskType === "url_ingest")
    return UrlIngestWorkflow.executionId({ pipelineRunId: run.activeTaskId }).pipe(
      Effect.flatMap((executionId) => UrlIngestWorkflow.poll(executionId)),
    );
  return Effect.succeed(Option.none<Workflow.Result<unknown, unknown>>());
};

const failureOf = (result: Option.Option<Workflow.Result<unknown, unknown>>) => {
  if (Option.isNone(result) || result.value._tag !== "Complete") return undefined;
  const { exit } = result.value;
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return undefined;
  return formatError(causeDetails(exit.cause));
};

export const settleRuns = Effect.gen(function* () {
  const db = yield* Database;
  const pipeline = yield* PipelineRunsService;
  const logger = yield* StructuredLogger;
  const active = yield* db.query((d) =>
    d
      .select({
        id: pipelineRuns.id,
        vaultId: pipelineRuns.vaultId,
        activeTaskId: pipelineRuns.activeTaskId,
        activeTaskType: pipelineRuns.activeTaskType,
        compileIntentId: pipelineRuns.compileIntentId,
      })
      .from(pipelineRuns)
      .where(inArray(pipelineRuns.status, ["pending", "running"]))
      .limit(500),
  );
  const exists = (rows: readonly unknown[]) => rows.length > 0;
  const continueWork = (run: ActiveRun) =>
    Effect.gen(function* () {
      const task = run.activeTaskId;
      if (run.activeTaskType === "compile" && task !== null) {
        const [intent] = yield* db.query((d) =>
          d
            .select({
              vaultId: compileIntents.vaultId,
              pipelineRunId: compileIntents.pipelineRunId,
              dispatchedAt: compileIntents.dispatchedAt,
            })
            .from(compileIntents)
            .where(and(eq(compileIntents.id, task), isNull(compileIntents.satisfiedAt)))
            .limit(1),
        );
        if (intent !== undefined && intent.dispatchedAt !== null) {
          yield* CompileWorkflow.execute(
            {
              intentId: task,
              vaultId: intent.vaultId,
              pipelineRunId: intent.pipelineRunId ?? run.id,
            },
            { discard: true },
          );
          return true;
        }
        if (intent !== undefined) return true;
      }
      if (run.activeTaskType === "url_ingest" && task !== null) {
        const [request] = yield* db.query((d) =>
          d
            .select({ dispatchedAt: urlIngestRequests.dispatchedAt })
            .from(urlIngestRequests)
            .where(eq(urlIngestRequests.id, task))
            .limit(1),
        );
        if (request !== undefined && request.dispatchedAt !== null) {
          yield* UrlIngestWorkflow.execute({ pipelineRunId: task }, { discard: true });
          return true;
        }
        if (request !== undefined) return true;
      }
      const intents = yield* db.query((d) =>
        d
          .select({ id: compileIntents.id })
          .from(compileIntents)
          .where(
            and(
              isNull(compileIntents.satisfiedAt),
              or(
                eq(compileIntents.pipelineRunId, run.id),
                run.compileIntentId === null
                  ? sql`false`
                  : eq(compileIntents.id, run.compileIntentId),
              ),
            ),
          )
          .limit(1),
      );
      if (exists(intents)) return true;
      const batches = yield* db.query((d) =>
        d
          .select({ id: fileIngestBatches.id })
          .from(fileIngestBatches)
          .where(
            and(
              eq(fileIngestBatches.id, run.id),
              inArray(fileIngestBatches.status, ["uploading", "processing"]),
            ),
          )
          .limit(1),
      );
      return exists(batches);
    });
  const settled: Uuid[] = [];
  for (const run of active) {
    const result =
      run.activeTaskId === null
        ? Option.none<Workflow.Result<unknown, unknown>>()
        : yield* pollTask({ ...run, activeTaskId: run.activeTaskId });
    const failure = failureOf(result);
    if (failure !== undefined) {
      yield* logger.warn("pipeline_run.settled_from_workflow", {
        pipeline_run_id: run.id,
        vault_id: run.vaultId,
        active_task_type: run.activeTaskType ?? "",
        error_message: failure,
      });
      yield* pipeline.failPreservingProgress(run.id, failure);
      settled.push(run.id);
      continue;
    }
    if (Option.isSome(result) || (yield* continueWork(run))) continue;
    yield* logger.warn("pipeline_run.lost", {
      pipeline_run_id: run.id,
      vault_id: run.vaultId,
      active_task_type: run.activeTaskType ?? "",
    });
    yield* pipeline.failPreservingProgress(run.id, LOST_RUN_ERROR);
    settled.push(run.id);
  }
  return settled;
});

export const RunSettlementLoopLive = Layer.effectDiscard(
  backgroundLoop({
    failureEvent: "run_settlement_tick_failed",
    interval: "30 seconds",
    tick: settleRuns,
  }),
);
