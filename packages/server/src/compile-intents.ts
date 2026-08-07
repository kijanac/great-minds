import { compileIntents, Database, pipelineRuns, tasks } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";

import { ClockService } from "./clock.ts";
import { AppConfig } from "./config.ts";
import { formatError } from "./error-details.ts";
import {
  CompilePhases,
  CompilePhaseFailed,
  CompilePhaseNotPorted,
  CompileWorkflowError,
  phaseFailure,
  ValidatedTopic,
  type CompilePhase,
} from "./compile-phases.ts";
import { StructuredLogger } from "./logging.ts";
import { PipelineRunsService } from "./pipeline-runs.ts";
import { workflowExecutionId } from "./workflow-engine.ts";

export const CompileWorkflow = Workflow.make("CompileTask", {
  payload: {
    intentId: Schema.String,
    vaultId: Schema.String,
    pipelineRunId: Schema.String,
  },
  idempotencyKey: ({ intentId }) => intentId,
  success: Schema.Void,
  error: CompileWorkflowError,
});

const causeFailure = (
  phase: CompilePhase,
  cause: Cause.Cause<unknown>,
): CompilePhaseNotPorted | CompilePhaseFailed => {
  const reason = cause.reasons[0];
  if (reason !== undefined && Cause.isFailReason(reason)) {
    const error = reason.error;
    if (error instanceof CompilePhaseNotPorted || error instanceof CompilePhaseFailed) return error;
    return phaseFailure(phase, error);
  }
  if (reason !== undefined && Cause.isDieReason(reason)) {
    return phaseFailure(phase, reason.defect);
  }
  return phaseFailure(phase, Cause.pretty(cause));
};

export const CompileWorkflowLive = Layer.unwrap(
  Effect.map(ClockService, (clock) =>
    CompileWorkflow.toLayer((payload) => {
  const runPhase = <Success extends Schema.Top, R>(
    phase: CompilePhase,
    success: Success,
    execute: Effect.Effect<Success["Type"], unknown, R>,
  ) =>
    Activity.make({
      name: `compile-phase-${phase}`,
      success,
      error: CompileWorkflowError,
      execute: execute.pipe(
        Effect.catchCause((cause) => {
          if (cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason)) {
            return Effect.interrupt;
          }
          const failure = causeFailure(phase, cause);
          return Effect.gen(function* () {
            if (failure instanceof CompilePhaseNotPorted) return yield* Effect.fail(failure);
            const pipeline = yield* PipelineRunsService;
            const logger = yield* StructuredLogger;
            const formatted = formatError(failure);
            yield* logger.error("compile_workflow.phase_failed", {
              vault_id: payload.vaultId,
              pipeline_run_id: payload.pipelineRunId,
              intent_id: payload.intentId,
              step: phase,
              error_type: failure.errorType,
              error_message: failure.message,
            });
            yield* pipeline.failPreservingProgress(
              payload.pipelineRunId as Uuid,
              formatted,
            );
            return yield* Effect.fail(failure);
          });
        }),
      ),
    });

  const phases = Effect.gen(function* () {
    const service = yield* CompilePhases;
    const vaultId = payload.vaultId as Uuid;
    const runId = payload.pipelineRunId as Uuid;
    yield* runPhase("ingest", Schema.Void, service.ingest(vaultId, runId));
    yield* runPhase("extract", Schema.Void, service.extract(vaultId, runId));
    const validated = yield* runPhase(
      "abstract",
      Schema.Array(ValidatedTopic),
      service.abstract(vaultId, runId),
    );
    if (validated.length === 0) {
      yield* runPhase(
        "publish",
        Schema.Void,
        Effect.gen(function* () {
          const pipeline = yield* PipelineRunsService;
          yield* pipeline.updateProgress(runId, "publish", "completed", [
            {
              key: "phase",
              label: "compile completed early: no validated topics",
              status: "completed",
              done: 1,
              total: 1,
              detail: "",
            },
          ]);
          yield* service.flushLlmCost(vaultId, runId);
        }),
      );
      return;
    }
    yield* runPhase("derive", Schema.Void, service.derive(vaultId, runId, validated));
    yield* runPhase("render", Schema.Void, service.render(vaultId, runId, validated));
    yield* runPhase("verify", Schema.Void, service.verify(vaultId, runId));
    const publishedAt = yield* Activity.make({
      name: "compile-publish-timestamp",
      success: Schema.String,
      execute: Effect.map(clock.now, (now) =>
        now.toISOString().replace(/\.\d{3}Z$/, "+00:00"),
      ),
    });
    yield* runPhase("publish", Schema.Void, service.publish(vaultId, runId, publishedAt));
  });
  return phases;
    }),
  ),
);

export const cancelCompileWorkflow = (runId: Uuid, intentId: string) =>
  Effect.gen(function* () {
    const pipeline = yield* PipelineRunsService;
    const engine = yield* WorkflowEngine.WorkflowEngine;
    yield* pipeline.cancel(runId);
    yield* engine.interruptUnsafe(
      CompileWorkflow,
      workflowExecutionId(CompileWorkflow._tag, intentId),
    );
  });

type CompileIntentReconcilerShape = {
  readonly reconcileOnce: () => Effect.Effect<
    { readonly satisfied: number; readonly dispatched: number },
    never,
    WorkflowEngine.WorkflowEngine
  >;
};

export class CompileIntentReconciler extends Context.Service<
  CompileIntentReconciler,
  CompileIntentReconcilerShape
>()("@great-minds/server/CompileIntentReconciler") {}

type Dispatch = {
  readonly intentId: Uuid;
  readonly vaultId: Uuid;
  readonly pipelineRunId: Uuid;
};

export const CompileIntentReconcilerLive = Layer.effect(
  CompileIntentReconciler,
  Effect.gen(function* () {
    const db = yield* Database;
    const pipeline = yield* PipelineRunsService;
    const config = yield* AppConfig;
    const clock = yield* ClockService;

    const markSatisfied = Effect.gen(function* () {
      const terminal = yield* db.query((d) => d
        .select({ intentId: compileIntents.id })
        .from(compileIntents)
        .innerJoin(pipelineRuns, eq(pipelineRuns.id, compileIntents.pipelineRunId))
        .where(
          and(
            isNotNull(compileIntents.dispatchedAt),
            isNotNull(compileIntents.dispatchedTaskId),
            isNull(compileIntents.satisfiedAt),
            inArray(pipelineRuns.status, ["completed", "failed", "cancelled"]),
            sql`EXISTS (
              SELECT 1
              FROM cluster_messages message
              -- 'Workflow/' + the CompileWorkflow tag; a tag rename must update this,
              -- pipeline-runs zombie recovery, and the parity reconciliation guard
              WHERE message.entity_type = 'Workflow/CompileTask'
                AND message.payload::jsonb ->> 'intentId' = ${compileIntents.id}::text
            )`,
          ),
        )
        .limit(200));
      if (terminal.length > 0) {
        yield* db.query((d) => d
          .update(compileIntents)
          .set({ satisfiedAt: sql`now()` })
          .where(
            inArray(
              compileIntents.id,
              terminal.map((row) => row.intentId),
            ),
          ));
      }
      return terminal.length;
    });

    const pendingDispatches = db
      .transaction((tx) =>
        Effect.gen(function* () {
          const pending = yield* tx
            .select({
              id: compileIntents.id,
              vaultId: compileIntents.vaultId,
              pipelineRunId: compileIntents.pipelineRunId,
            })
            .from(compileIntents)
            .where(isNull(compileIntents.dispatchedAt))
            .orderBy(asc(compileIntents.createdAt))
            .limit(100)
            .for("update", { skipLocked: true });
          const dispatches: Dispatch[] = [];
          for (const intent of pending) {
            const active = yield* tx
              .select({ id: pipelineRuns.id })
              .from(pipelineRuns)
              .where(
                and(
                  eq(pipelineRuns.vaultId, intent.vaultId),
                  eq(pipelineRuns.activeTaskType, "compile"),
                  inArray(pipelineRuns.status, ["pending", "running"]),
                ),
              )
              .limit(1);
            if (active.length > 0) {
              continue;
            }
            const runId = (intent.pipelineRunId ?? intent.id) as Uuid;
            if (intent.pipelineRunId === null) {
              yield* tx
                .insert(pipelineRuns)
                .values({
                  id: runId,
                  vaultId: intent.vaultId,
                  trigger: "manual",
                  status: "pending",
                  currentPhase: "",
                  phaseStatus: "",
                  progressSteps: [],
                  compileIntentId: intent.id,
                })
                .onConflictDoNothing({ target: pipelineRuns.id });
              yield* tx
                .update(compileIntents)
                .set({ pipelineRunId: runId })
                .where(eq(compileIntents.id, intent.id));
            }
            dispatches.push({
              intentId: intent.id as Uuid,
              vaultId: intent.vaultId as Uuid,
              pipelineRunId: runId,
            });
          }
          return dispatches;
        }),
      );

    const dispatch = (item: Dispatch) =>
      Effect.gen(function* () {
        yield* CompileWorkflow.execute(
          {
            intentId: item.intentId,
            vaultId: item.vaultId,
            pipelineRunId: item.pipelineRunId,
          },
          { discard: true },
        );
        yield* db.query((d) => d
          .insert(tasks)
          .values({
            id: item.intentId,
            vaultId: item.vaultId,
            type: "compile",
            params: {
              intent_id: item.intentId,
              vault_id: item.vaultId,
              pipeline_run_id: item.pipelineRunId,
            },
            pipelineRunId: item.pipelineRunId,
          })
          .onConflictDoNothing({ target: tasks.id }));
        yield* db.query((d) => d
          .update(compileIntents)
          .set({ dispatchedAt: sql`now()`, dispatchedTaskId: item.intentId })
          .where(eq(compileIntents.id, item.intentId)));
        yield* db.query((d) => d
          .update(pipelineRuns)
          .set({
            compileTaskId: item.intentId,
            activeTaskId: item.intentId,
            activeTaskType: "compile",
            updatedAt: sql`now()`,
          })
          .where(eq(pipelineRuns.id, item.pipelineRunId)));
      });

    return {
      reconcileOnce: () =>
        Effect.gen(function* () {
          const satisfied = yield* markSatisfied;
          const dispatches = yield* pendingDispatches;
          yield* Effect.forEach(dispatches, dispatch, { concurrency: config.pipelineConcurrency });
          const now = yield* clock.now;
          const cutoff = new Date(now.getTime() - 120_000);
          yield* pipeline.recoverZombies(cutoff);
          return { satisfied, dispatched: dispatches.length };
        }),
    } satisfies CompileIntentReconcilerShape;
  }),
);

export const CompileIntentReconcilerLoopLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const reconciler = yield* CompileIntentReconciler;
    const logger = yield* StructuredLogger;
    const tick = reconciler.reconcileOnce().pipe(
      Effect.catchCause((cause) =>
        logger.warn("intent_reconciler_tick_failed", {
          error: "Cause",
          error_message: Cause.pretty(cause),
        }),
      ),
    );
    yield* tick;
    yield* Effect.forkScoped(Effect.forever(Effect.sleep("5 seconds").pipe(Effect.andThen(tick))));
  }),
);
