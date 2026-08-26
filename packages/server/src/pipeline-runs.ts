import { Database, pipelineRuns } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

export type PipelineProgressStep = {
  readonly key: string;
  readonly label: string;
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly done: number | null;
  readonly total: number | null;
  readonly detail: string;
};

type PipelineRunsServiceShape = {
  readonly cancel: (runId: Uuid) => Effect.Effect<void>;
  readonly isActive: (runId: Uuid) => Effect.Effect<boolean>;
  readonly updateProgress: (
    runId: Uuid,
    phase: string,
    phaseStatus: string,
    steps: readonly PipelineProgressStep[],
    error?: string,
  ) => Effect.Effect<void>;
  readonly failPreservingProgress: (runId: Uuid, error: string) => Effect.Effect<void>;
  readonly fail: (runId: Uuid, error: string) => Effect.Effect<void>;
  readonly recoverZombies: (olderThan: Date) => Effect.Effect<number>;
};

export class PipelineRunsService extends Context.Service<
  PipelineRunsService,
  PipelineRunsServiceShape
>()("@great-minds/server/PipelineRunsService") {}

export const progressSteps = (
  labels: Record<string, string>,
  active: string,
  options: {
    readonly completed?: ReadonlySet<string>;
    readonly failed?: ReadonlySet<string>;
    readonly counts?: Readonly<Record<string, readonly [number | null, number | null]>>;
    readonly details?: Readonly<Record<string, string>>;
  } = {},
): readonly PipelineProgressStep[] =>
  Object.entries(labels).map(([key, label]) => {
    const [done, total] = options.counts?.[key] ?? [null, null];
    return {
      key,
      label,
      status: options.failed?.has(key)
        ? "failed"
        : options.completed?.has(key)
          ? "completed"
          : key === active
            ? "running"
            : "pending",
      done,
      total,
      detail: options.details?.[key] ?? "",
    };
  });

export const PipelineRunsServiceLive = Layer.effect(
  PipelineRunsService,
  Effect.gen(function* () {
    const db = yield* Database;
    const updateProgress: PipelineRunsServiceShape["updateProgress"] = (
      runId,
      phase,
      phaseStatus,
      steps,
      error,
    ) =>
      db.query((d) => d
        .update(pipelineRuns)
        .set({
          currentPhase: phase,
          phaseStatus,
          progressSteps: [...steps],
          status:
            phaseStatus === "failed"
              ? "failed"
              : phase === "publish" && phaseStatus === "completed"
                ? "completed"
                : "running",
          error,
          completedAt:
            phaseStatus === "failed" || (phase === "publish" && phaseStatus === "completed")
              ? sql`now()`
              : undefined,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ["pending", "running"])),
        ))
        .pipe(Effect.asVoid);

    return {
      isActive: (runId) =>
        db.query((d) => d
          .select({ id: pipelineRuns.id })
          .from(pipelineRuns)
          .where(
            and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ["pending", "running"])),
          )
          .limit(1))
          .pipe(Effect.map((rows) => rows.length === 1)),
      cancel: (runId) =>
        db.query((d) => d
          .update(pipelineRuns)
          .set({
            status: "cancelled",
            phaseStatus: "failed",
            error: "Update cancelled",
            completedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ["pending", "running"])),
          ))
          .pipe(Effect.asVoid),
      updateProgress,
      failPreservingProgress: (runId, error) =>
        db.query((d) => d
          .update(pipelineRuns)
          .set({
            status: "failed",
            phaseStatus: "failed",
            error,
            completedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ["pending", "running"])),
          ))
          .pipe(Effect.asVoid),
      fail: (runId, error) => updateProgress(runId, "source_ingest", "failed", [], error),
      recoverZombies: (olderThan) =>
        Effect.gen(function* () {
          const rows = yield* db.query((d) => d
            .update(pipelineRuns)
            .set({
              status: "failed",
              phaseStatus: "failed",
              error: "Pipeline interrupted — server may have restarted during processing.",
              completedAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                inArray(pipelineRuns.status, ["pending", "running"]),
                lt(pipelineRuns.updatedAt, olderThan),
                sql`(
                  (
                    ${pipelineRuns.activeTaskId} IS NULL
                    AND NOT EXISTS (
                      SELECT 1
                      FROM compile_intents intent
                      WHERE intent.pipeline_run_id = ${pipelineRuns.id}
                        AND intent.satisfied_at IS NULL
                    )
                    AND NOT EXISTS (
                      SELECT 1
                      FROM file_ingest_batches batch
                      WHERE batch.id = ${pipelineRuns.id}
                        AND batch.status = 'uploading'
                    )
                  )
                  OR
                  (
                    ${pipelineRuns.activeTaskId} IS NOT NULL
                    AND NOT EXISTS (
                      SELECT 1
                      FROM file_ingest_batches batch
                      WHERE batch.id = ${pipelineRuns.id}
                        AND batch.status = 'processing'
                    )
                    AND NOT EXISTS (
                      SELECT 1
                      FROM cluster_messages message
                      -- entity_type is 'Workflow/' + the Workflow.make tag; renaming a
                      -- workflow tag must update this list or zombie recovery goes blind
                      WHERE (
                        ${pipelineRuns.activeTaskType} = 'staged_file_ingest'
                        AND message.entity_type = 'Workflow/StagedFileIngest'
                        AND message.payload::jsonb ->> 'pipelineRunId' = ${pipelineRuns.id}::text
                      ) OR (
                        ${pipelineRuns.activeTaskType} = 'compile'
                        AND message.entity_type = 'Workflow/CompileTask'
                        AND message.payload::jsonb ->> 'intentId' = ${pipelineRuns.activeTaskId}::text
                      )
                    )
                  )
                )`,
              ),
            )
            .returning({ id: pipelineRuns.id }));
          return rows.length;
        }),
    } satisfies PipelineRunsServiceShape;
  }),
);
