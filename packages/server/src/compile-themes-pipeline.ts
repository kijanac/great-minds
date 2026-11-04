import { backlinks, type Database, topicLinks, topics, wikiArticles } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { eq, inArray, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import { buildArticles } from "./compile-articles.ts";
import { makeAskRunner, type Progress } from "./compile-asks.ts";
import {
  THEMES_ABSTRACT_STEP_LABELS,
  THEMES_RENDER_STEP_LABELS,
  topicContentHash,
  type ArchiveTransition,
  type ValidatedTopic,
} from "./compile-contract.ts";
import { findLinks, withLinks } from "./compile-links.ts";
import {
  groupThemes,
  loadBlocks,
  loadLibrary,
  pairCandidates,
  proposeTopics,
} from "./compile-themes.ts";
import { writeArticles } from "./compile-write.ts";
import type { AppConfigShape } from "./config.ts";
import type { EmbeddingsService } from "./embeddings.ts";
import type { LanguageModel } from "./llm.ts";
import type { StructuredLogger } from "./logging.ts";
import { progressSteps, type PipelineRunsService } from "./pipeline-runs.ts";
import { loadPrompt } from "./prompts.ts";
import type { ContentStorage } from "./storage.ts";
import { defaultVaultConfigFile, readVaultConfig } from "./vault-config.ts";

const PIVOTS_IN_FLIGHT = 120;

const slugify = (title: string, seen: Set<string>) => {
  const base =
    title
      .toLowerCase()
      .replaceAll("'", "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "topic";
  let slug = base;
  let suffix = 2;
  while (seen.has(slug)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  seen.add(slug);
  return slug;
};

const tightFootnotes = (markdown: string) => markdown.replace(/ +(\[\^\d+\])/g, "$1");

export const makeThemesPipeline = (options: {
  readonly config: AppConfigShape;
  readonly db: Database["Service"];
  readonly embeddings: EmbeddingsService["Service"];
  readonly languageModel: LanguageModel["Service"];
  readonly logger: StructuredLogger["Service"];
  readonly pipeline: PipelineRunsService["Service"];
  readonly storage: ContentStorage["Service"];
  readonly archiveTransitions: (
    vaultId: Uuid,
    transitions: readonly ArchiveTransition[],
  ) => Effect.Effect<void, unknown>;
  readonly materializeArticle: (
    vaultId: Uuid,
    runId: Uuid,
    topic: ValidatedTopic,
    output: { readonly body: string; readonly tags: readonly string[] },
  ) => Effect.Effect<void, unknown>;
  readonly rebuildWiki: (vaultId: Uuid, runId: Uuid) => Effect.Effect<number, unknown>;
}) => {
  const { config, db, embeddings, languageModel, logger, pipeline, storage } = options;
  const runnerFor = (vaultId: Uuid, runId: Uuid) =>
    makeAskRunner({ db, languageModel, logger }, { vaultId, runId });
  const warn = (runId: Uuid, phase: string, count: number, message: string) =>
    count === 0 ? Effect.void : pipeline.recordWarning(runId, { phase, message, count, items: [] });
  const promptsFor = (vaultId: Uuid) =>
    Effect.gen(function* () {
      const vaultConfig = yield* readVaultConfig(storage, vaultId).pipe(
        Effect.catchTag("VaultConfigMalformed", () => Effect.succeed(defaultVaultConfigFile)),
      );
      const hint = vaultConfig.thematicHint.trim();
      const focus =
        hint === "" ? "" : ` Its editorial focus: ${/[.!?]$/.test(hint) ? hint : `${hint}.`}`;
      return (name: string) =>
        loadPrompt(storage, vaultId, name).pipe(
          Effect.map((text) => text.replaceAll("{vault_focus}", () => focus)),
        );
    });
  const stepper = (runId: Uuid, phase: string, labels: Record<string, string>) => {
    const counts: Record<string, readonly [number, number]> = {};
    const completed = new Set<string>();
    let active = "";
    let written = -1;
    const start = (step: string) =>
      Effect.suspend(() => {
        if (active !== "") completed.add(active);
        active = step;
        written = -1;
        return pipeline.updateProgress(
          runId,
          phase,
          "progress",
          progressSteps(labels, active, { completed, counts }),
        );
      });
    const progress: Progress = (step, done, total) =>
      Effect.suspend(() => {
        counts[step] = [done, total];
        if (step !== active) return Effect.void;
        if (done !== total && written >= 0 && done - written < Math.max(1, total / 100))
          return Effect.void;
        written = done;
        return pipeline.updateProgress(
          runId,
          phase,
          "progress",
          progressSteps(labels, active, { completed, counts }),
        );
      });
    const finish = Effect.suspend(() =>
      pipeline.updateProgress(
        runId,
        phase,
        "completed",
        progressSteps(labels, active, { completed: new Set(Object.keys(labels)), counts }),
      ),
    );
    return { start, progress, finish };
  };

  const abstract = (vaultId: Uuid, runId: Uuid) =>
    Effect.gen(function* () {
      const runner = yield* runnerFor(vaultId, runId);
      const prompt = yield* promptsFor(vaultId);
      const steps = stepper(runId, "abstract", THEMES_ABSTRACT_STEP_LABELS);
      const themeSettings = {
        model: config.mapModel,
        proposePrompt: yield* prompt("propose_topics"),
        judgePrompt: yield* prompt("judge_same_topic"),
        concurrency: config.compileEnrichConcurrency,
        pivotsInFlight: PIVOTS_IN_FLIGHT,
        progress: steps.progress,
      };
      yield* steps.start("propose_topics");
      const library = yield* loadLibrary(db, vaultId);
      const proposed = yield* proposeTopics(
        { db, embeddings, runner },
        vaultId,
        library,
        themeSettings,
      );
      yield* steps.start("group_topics");
      yield* pairCandidates(db, vaultId);
      const blocks = yield* loadBlocks(db, vaultId, library);
      const grouped = yield* groupThemes(
        { db, embeddings, runner },
        vaultId,
        blocks,
        themeSettings,
      );
      yield* steps.start("build_articles");
      const built = yield* buildArticles({ db, runner }, blocks, grouped.themes, {
        model: config.mapModel,
        mergePrompt: yield* prompt("judge_same_entry"),
        placePrompt: yield* prompt("place_in_article"),
        concurrency: config.compileEnrichConcurrency,
        pivotsInFlight: PIVOTS_IN_FLIGHT,
        progress: steps.progress,
      });
      yield* warn(
        runId,
        "abstract",
        proposed.failedDocuments,
        "documents could not be read for topics",
      );
      yield* warn(
        runId,
        "abstract",
        grouped.failedJudgments + built.failedQuestions,
        "grouping questions failed",
      );

      const existing = yield* db.query((d) =>
        d
          .select({ topicId: topics.topicId, slug: topics.slug, status: topics.articleStatus })
          .from(topics)
          .where(eq(topics.vaultId, vaultId)),
      );
      const kept = new Set(built.articles.map((article) => article.id));
      const existingById = new Map(existing.map((topic) => [topic.topicId, topic]));
      const seen = new Set(
        existing.filter((topic) => kept.has(topic.topicId)).map((topic) => topic.slug),
      );
      const validated = built.articles.map((article): ValidatedTopic => ({
        topicId: article.id,
        slug: existingById.get(article.id)?.slug ?? slugify(article.title, seen),
        title: article.title,
        description: article.description,
        subsumedIdeaIds: article.ideaIds,
      }));
      yield* options.archiveTransitions(
        vaultId,
        existing
          .filter((topic) => !kept.has(topic.topicId) && topic.status !== "archived")
          .map((topic) => ({ topicId: topic.topicId, slug: topic.slug, supersededBy: null })),
      );
      const taken = new Set(validated.map((topic) => topic.slug));
      const vacated = existing
        .filter((topic) => !kept.has(topic.topicId) && taken.has(topic.slug))
        .map((topic) => topic.topicId);
      if (vacated.length > 0)
        yield* db.query((d) =>
          d
            .update(topics)
            .set({ slug: sql`'~' || ${topics.topicId}::text` })
            .where(inArray(topics.topicId, vacated)),
        );
      if (validated.length > 0)
        yield* db.query((d) =>
          d
            .insert(topics)
            .values(
              validated.map((topic) => ({
                topicId: topic.topicId,
                vaultId,
                slug: topic.slug,
                title: topic.title,
                description: topic.description,
                compiledFromHash: topicContentHash(topic),
              })),
            )
            .onConflictDoUpdate({
              target: topics.topicId,
              set: {
                title: sql`excluded.title`,
                description: sql`excluded.description`,
                compiledFromHash: sql`excluded.compiled_from_hash`,
                articleStatus: sql`case when ${topics.articleStatus} = 'archived' then 'no_article' else ${topics.articleStatus} end`,
                supersededBy: null,
                updatedAt: sql`now()`,
              },
            }),
        );
      yield* steps.finish;
      return validated;
    });

  const render = (vaultId: Uuid, runId: Uuid, validated: readonly ValidatedTopic[]) =>
    Effect.gen(function* () {
      const runner = yield* runnerFor(vaultId, runId);
      const prompt = yield* promptsFor(vaultId);
      const steps = stepper(runId, "render", THEMES_RENDER_STEP_LABELS);
      yield* steps.start("write_articles");
      const written = yield* writeArticles(
        { db, runner },
        vaultId,
        validated.map((topic) => ({
          id: topic.topicId,
          title: topic.title,
          description: topic.description,
          ideaIds: topic.subsumedIdeaIds,
        })),
        {
          model: config.renderModel,
          prompt: yield* prompt("write_article"),
          temperature: Option.getOrUndefined(config.renderTemperature),
          reasoningEffort: Option.getOrUndefined(config.renderReasoningEffort),
          concurrency: config.compileWriteConcurrency,
          progress: steps.progress,
        },
      );
      yield* steps.start("link_articles");
      const linked = yield* findLinks(
        { embeddings, runner },
        validated.map((topic) => ({
          id: topic.topicId,
          title: topic.title,
          description: topic.description,
        })),
        written.articles.map((article) => ({ id: article.id, body: article.markdown })),
        {
          pickModel: config.mapModel,
          checkModel: config.reduceModel,
          mentionPrompt: yield* prompt("find_mentions"),
          pickPrompt: yield* prompt("pick_link_target"),
          checkPrompt: yield* prompt("check_link"),
          embeddingModel: config.embeddingModel,
          concurrency: config.compileEnrichConcurrency,
          progress: steps.progress,
        },
      );
      yield* steps.start("index_articles");
      const topicById = new Map(validated.map((topic) => [topic.topicId, topic]));
      const live = new Set(written.articles.map((article) => article.id));
      const hrefOf = (target: Uuid) => {
        const topic = topicById.get(target);
        return topic === undefined || !live.has(target) ? undefined : `wiki/${topic.slug}.md`;
      };
      for (const article of written.articles) {
        const topic = topicById.get(article.id);
        if (topic === undefined) continue;
        yield* options.materializeArticle(vaultId, runId, topic, {
          body: tightFootnotes(
            withLinks(article.markdown, linked.linksOf.get(article.id) ?? [], hrefOf),
          ),
          tags: article.tags,
        });
      }
      const ids = validated.map((topic) => topic.topicId);
      if (ids.length > 0)
        yield* db.query((d) => d.delete(topicLinks).where(inArray(topicLinks.sourceTopicId, ids)));
      const edges = new Map<string, { sourceTopicId: Uuid; targetTopicId: Uuid }>();
      for (const [source, links] of linked.linksOf)
        for (const link of links)
          if (live.has(source) && live.has(link.target) && source !== link.target)
            edges.set(`${source}>${link.target}`, {
              sourceTopicId: source,
              targetTopicId: link.target,
            });
      if (edges.size > 0) yield* db.query((d) => d.insert(topicLinks).values([...edges.values()]));
      const pages =
        ids.length === 0
          ? []
          : yield* db.query((d) =>
              d
                .select({ id: wikiArticles.id, topicId: wikiArticles.topicId })
                .from(wikiArticles)
                .where(inArray(wikiArticles.topicId, ids)),
            );
      const pageOf = new Map(pages.map((page) => [page.topicId, page.id]));
      const rewritten = pages.filter((page) => live.has(page.topicId)).map((page) => page.id);
      if (rewritten.length > 0)
        yield* db.query((d) =>
          d.delete(backlinks).where(inArray(backlinks.sourceArticleId, rewritten)),
        );
      const pageEdges = [...edges.values()].flatMap((edge) => {
        const sourceArticleId = pageOf.get(edge.sourceTopicId);
        const targetArticleId = pageOf.get(edge.targetTopicId);
        return sourceArticleId === undefined || targetArticleId === undefined
          ? []
          : [{ sourceArticleId, targetArticleId }];
      });
      if (pageEdges.length > 0) yield* db.query((d) => d.insert(backlinks).values(pageEdges));
      yield* warn(
        runId,
        "render",
        written.failedArticles,
        `of ${validated.length} articles could not be written`,
      );
      yield* warn(runId, "render", linked.failedQuestions, "link questions failed");
      yield* options.rebuildWiki(vaultId, runId);
      yield* steps.finish;
    });

  return { abstract, render };
};
