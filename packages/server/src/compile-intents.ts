import { compileIntents, Database, pipelineRuns, tasks } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import * as Workflow from "effect/unstable/workflow/Workflow";
import type * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";

import { dieDatabase } from "./db-defects.ts";
import { StructuredLogger } from "./logging.ts";
import { PipelineRunsService } from "./pipeline-runs.ts";

export const CompileWorkflow = Workflow.make("CompilePlaceholder", {
  payload: {
    intentId: Schema.String,
    vaultId: Schema.String,
    pipelineRunId: Schema.String,
  },
  idempotencyKey: ({ intentId }) => intentId,
  success: Schema.Void,
});

export const CompileWorkflowLive = CompileWorkflow.toLayer((payload) =>
  Activity.make({
    name: "compile-placeholder",
    execute: Effect.gen(function* () {
      const pipeline = yield* PipelineRunsService;
      yield* pipeline.updateProgress(payload.pipelineRunId as Uuid, "publish", "completed", [
        {
          key: "compile_placeholder",
          label: "Compile workflow seam ready",
          status: "completed",
          done: 1,
          total: 1,
          detail: "M4.3 replaces this activity with the seven-phase compile workflow",
        },
      ]);
    }),
  }),
);

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

    const markSatisfied = Effect.gen(function* () {
      const terminal = yield* db
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
              WHERE message.entity_type = 'Workflow/CompilePlaceholder'
                AND message.payload::jsonb ->> 'intentId' = ${compileIntents.id}::text
            )`,
          ),
        )
        .limit(200)
        .pipe(dieDatabase);
      if (terminal.length > 0) {
        yield* db
          .update(compileIntents)
          .set({ satisfiedAt: sql`now()` })
          .where(
            inArray(
              compileIntents.id,
              terminal.map((row) => row.intentId),
            ),
          )
          .pipe(dieDatabase);
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
      )
      .pipe(dieDatabase);

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
        yield* db
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
          .onConflictDoNothing({ target: tasks.id })
          .pipe(dieDatabase);
        yield* db
          .update(compileIntents)
          .set({ dispatchedAt: sql`now()`, dispatchedTaskId: item.intentId })
          .where(eq(compileIntents.id, item.intentId))
          .pipe(dieDatabase);
        yield* db
          .update(pipelineRuns)
          .set({
            compileTaskId: item.intentId,
            activeTaskId: item.intentId,
            activeTaskType: "compile",
            updatedAt: sql`now()`,
          })
          .where(eq(pipelineRuns.id, item.pipelineRunId))
          .pipe(dieDatabase);
      });

    return {
      reconcileOnce: () =>
        Effect.gen(function* () {
          const satisfied = yield* markSatisfied;
          const dispatches = yield* pendingDispatches;
          yield* Effect.forEach(dispatches, dispatch, { concurrency: 1 });
          const cutoff = new Date(Date.now() - 120_000);
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
