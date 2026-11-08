import {
  compileCacheEntries,
  compileIntents,
  Database,
  pipelineRuns,
  topics,
  wikiArticles,
} from "@great-minds/database";
import type { PipelineProgressStep, PipelineWarning, Uuid } from "@great-minds/domain";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

type PipelineRunsServiceShape = {
  readonly cancel: (runId: Uuid) => Effect.Effect<void>;
  readonly cancelCompileIntent: (intentId: Uuid) => Effect.Effect<void>;
  readonly isActive: (runId: Uuid) => Effect.Effect<boolean>;
  readonly updateProgress: (
    runId: Uuid,
    phase: string,
    phaseStatus: string,
    steps: readonly PipelineProgressStep[],
    error?: string,
  ) => Effect.Effect<void>;
  readonly recordWarning: (runId: Uuid, warning: PipelineWarning) => Effect.Effect<void>;
  readonly failPreservingProgress: (runId: Uuid, error: string) => Effect.Effect<void>;
  readonly fail: (runId: Uuid, error: string) => Effect.Effect<void>;
  readonly runOfIntent: (
    intentId: Uuid,
  ) => Effect.Effect<{ readonly id: Uuid; readonly vaultId: Uuid } | undefined>;
  readonly recordOutcome: (runId: Uuid) => Effect.Effect<void>;
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
    const runOrCompileGroup = (runId: Uuid) => sql`(
      ${pipelineRuns.id} = ${runId}
      OR ${pipelineRuns.compileIntentId} = (
        SELECT anchor.compile_intent_id
        FROM pipeline_runs AS anchor
        WHERE anchor.id = ${runId}
      )
    )`;
    const recordOutcome = (runId: Uuid) =>
      Effect.gen(function* () {
        const [run] = yield* db.query((d) =>
          d
            .select({ vaultId: pipelineRuns.vaultId, createdAt: pipelineRuns.createdAt })
            .from(pipelineRuns)
            .where(eq(pipelineRuns.id, runId)),
        );
        if (run === undefined) return;
        const articles = yield* db.query((d) =>
          d
            .select({
              topicId: wikiArticles.topicId,
              title: wikiArticles.title,
              filePath: wikiArticles.filePath,
              archived: wikiArticles.archived,
              addedRunId: wikiArticles.addedRunId,
              changedRunId: wikiArticles.changedRunId,
              archivedRunId: wikiArticles.archivedRunId,
              supersededBy: topics.supersededBy,
            })
            .from(wikiArticles)
            .innerJoin(topics, eq(topics.topicId, wikiArticles.topicId))
            .where(
              and(
                eq(wikiArticles.vaultId, run.vaultId),
                sql`${wikiArticles.filePath} <> 'wiki/_index.md'`,
              ),
            )
            .orderBy(asc(sql`lower(${wikiArticles.title})`)),
        );
        const [sources] = yield* db.query((d) =>
          d
            .select({ count: sql<number>`count(*)::int` })
            .from(compileCacheEntries)
            .where(
              and(
                eq(compileCacheEntries.vaultId, run.vaultId),
                eq(compileCacheEntries.phase, "extract"),
                sql`${compileCacheEntries.createdAt} >= ${run.createdAt}`,
              ),
            ),
        );
        const entry = (article: (typeof articles)[number]) => ({
          title: article.title,
          file_path: article.filePath,
        });
        const live = articles.filter((article) => !article.archived);
        const liveByTopic = new Map(live.map((article) => [article.topicId, article]));
        const removedEntry = (article: (typeof articles)[number]) => {
          const successor =
            article.supersededBy === null ? undefined : liveByTopic.get(article.supersededBy);
          return successor === undefined
            ? entry(article)
            : { ...entry(article), merged_into: entry(successor) };
        };
        const added = live.filter((article) => article.addedRunId === runId);
        const changed = live.filter(
          (article) => article.addedRunId !== runId && article.changedRunId === runId,
        );
        const removed = articles.filter(
          (article) => article.archived && article.archivedRunId === runId,
        );
        yield* db.query((d) =>
          d
            .update(pipelineRuns)
            .set({
              outcome: {
                sources: sources?.count ?? 0,
                added: added.map(entry),
                changed: changed.map(entry),
                removed: removed.map(removedEntry),
                unchanged: live.length - added.length - changed.length,
              },
            })
            .where(eq(pipelineRuns.id, runId)),
        );
      });

    const updateProgress: PipelineRunsServiceShape["updateProgress"] = (
      runId,
      phase,
      phaseStatus,
      steps,
      error,
    ) =>
      db
        .query((d) =>
          d
            .update(pipelineRuns)
            .set({
              currentPhase: phase,
              phaseStatus,
              stages: sql`(
            select coalesce(jsonb_agg(stage order by position), '[]'::jsonb)
            from jsonb_array_elements(${pipelineRuns.stages}) with ordinality as listed(stage, position)
            where stage ->> 'phase' <> ${phase}
          ) || jsonb_build_array(${JSON.stringify({ phase, steps })}::jsonb)`,
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
              and(runOrCompileGroup(runId), inArray(pipelineRuns.status, ["pending", "running"])),
            ),
        )
        .pipe(Effect.asVoid);

    return {
      isActive: (runId) =>
        db
          .query((d) =>
            d
              .select({ id: pipelineRuns.id })
              .from(pipelineRuns)
              .where(
                and(
                  eq(pipelineRuns.id, runId),
                  inArray(pipelineRuns.status, ["pending", "running"]),
                ),
              )
              .limit(1),
          )
          .pipe(Effect.map((rows) => rows.length === 1)),
      cancel: (runId) =>
        db
          .query((d) =>
            d
              .update(pipelineRuns)
              .set({
                status: "cancelled",
                phaseStatus: "failed",
                error: "Update cancelled",
                completedAt: sql`now()`,
                updatedAt: sql`now()`,
              })
              .where(
                and(
                  eq(pipelineRuns.id, runId),
                  inArray(pipelineRuns.status, ["pending", "running"]),
                ),
              ),
          )
          .pipe(Effect.andThen(recordOutcome(runId))),
      cancelCompileIntent: (intentId) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(pipelineRuns)
                .set({
                  status: "cancelled",
                  phaseStatus: "failed",
                  error: "Update cancelled",
                  completedAt: sql`now()`,
                  updatedAt: sql`now()`,
                })
                .where(
                  and(
                    eq(pipelineRuns.compileIntentId, intentId),
                    inArray(pipelineRuns.status, ["pending", "running"]),
                  ),
                );
              yield* tx
                .update(compileIntents)
                .set({
                  dispatchedAt: sql`coalesce(${compileIntents.dispatchedAt}, now())`,
                  satisfiedAt: sql`coalesce(${compileIntents.satisfiedAt}, now())`,
                })
                .where(eq(compileIntents.id, intentId));
              return yield* tx
                .select({ id: pipelineRuns.id })
                .from(pipelineRuns)
                .where(eq(pipelineRuns.compileIntentId, intentId));
            }),
          )
          .pipe(
            Effect.flatMap((runs) => Effect.forEach(runs, (run) => recordOutcome(run.id))),
            Effect.asVoid,
          ),
      updateProgress,
      recordWarning: (runId, warning) =>
        db
          .query((d) =>
            d
              .update(pipelineRuns)
              .set({
                warnings: sql`(
              select coalesce(jsonb_agg(listed order by position), '[]'::jsonb)
              from jsonb_array_elements(${pipelineRuns.warnings}) with ordinality as kept(listed, position)
              where (listed ->> 'phase', listed ->> 'message') <> (${warning.phase}, ${warning.message})
            ) || jsonb_build_array(${JSON.stringify(warning)}::jsonb)`,
                updatedAt: sql`now()`,
              })
              .where(
                and(runOrCompileGroup(runId), inArray(pipelineRuns.status, ["pending", "running"])),
              ),
          )
          .pipe(Effect.asVoid),
      failPreservingProgress: (runId, error) =>
        db
          .query((d) =>
            d
              .update(pipelineRuns)
              .set({
                status: "failed",
                phaseStatus: "failed",
                error,
                completedAt: sql`now()`,
                updatedAt: sql`now()`,
              })
              .where(
                and(runOrCompileGroup(runId), inArray(pipelineRuns.status, ["pending", "running"])),
              ),
          )
          .pipe(Effect.andThen(recordOutcome(runId))),
      fail: (runId, error) => updateProgress(runId, "source_ingest", "failed", [], error),
      runOfIntent: (intentId) =>
        db
          .query((d) =>
            d
              .select({ id: pipelineRuns.id, vaultId: pipelineRuns.vaultId })
              .from(pipelineRuns)
              .innerJoin(compileIntents, eq(compileIntents.pipelineRunId, pipelineRuns.id))
              .where(eq(compileIntents.id, intentId))
              .limit(1),
          )
          .pipe(Effect.map((rows) => rows[0])),
      recordOutcome,
    } satisfies PipelineRunsServiceShape;
  }),
);
