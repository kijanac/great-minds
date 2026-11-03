import { type Database, topicLinks, topics } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { eq, inArray, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import { buildArticles } from "./compile-articles.ts";
import { makeAskRunner } from "./compile-asks.ts";
import {
  THEMES_ABSTRACT_STEP_LABELS,
  THEMES_RENDER_STEP_LABELS,
  topicContentHash,
  type ArchiveTransition,
  type ValidatedTopic,
} from "./compile-contract.ts";
import { findLinks, withLinks } from "./compile-links.ts";
import { slugifyRegistry } from "./compile-llm-core.ts";
import { groupThemes, pairCandidates, proposeTopics } from "./compile-themes.ts";
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
  const shortfall = (runId: Uuid, count: number, what: string) =>
    count === 0 ? Effect.void : pipeline.recordShortfall(runId, `${count} ${what}`);
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
  const abstractStep = (runId: Uuid, active: string, completed: readonly string[]) =>
    pipeline.updateProgress(
      runId,
      "abstract",
      "progress",
      progressSteps(THEMES_ABSTRACT_STEP_LABELS, active, { completed: new Set(completed) }),
    );
  const renderStep = (runId: Uuid, active: string, completed: readonly string[]) =>
    pipeline.updateProgress(
      runId,
      "render",
      "progress",
      progressSteps(THEMES_RENDER_STEP_LABELS, active, { completed: new Set(completed) }),
    );

  const abstract = (vaultId: Uuid, runId: Uuid) =>
    Effect.gen(function* () {
      const runner = yield* runnerFor(vaultId, runId);
      const prompt = yield* promptsFor(vaultId);
      const themeSettings = {
        model: config.mapModel,
        proposePrompt: yield* prompt("propose_topics"),
        judgePrompt: yield* prompt("judge_same_topic"),
        concurrency: config.compileEnrichConcurrency,
        pivotsInFlight: PIVOTS_IN_FLIGHT,
      };
      yield* abstractStep(runId, "propose_topics", []);
      const proposed = yield* proposeTopics({ db, embeddings, runner }, vaultId, themeSettings);
      yield* abstractStep(runId, "group_topics", ["propose_topics"]);
      yield* pairCandidates(db, vaultId);
      const grouped = yield* groupThemes({ db, embeddings, runner }, vaultId, themeSettings);
      yield* abstractStep(runId, "build_articles", ["propose_topics", "group_topics"]);
      const built = yield* buildArticles({ db, runner }, vaultId, grouped.themes, {
        model: config.mapModel,
        mergePrompt: yield* prompt("judge_same_entry"),
        placePrompt: yield* prompt("place_in_article"),
        concurrency: config.compileEnrichConcurrency,
        pivotsInFlight: PIVOTS_IN_FLIGHT,
      });
      yield* shortfall(runId, proposed.failedDocuments, "documents could not be read for topics");
      yield* shortfall(
        runId,
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
        slug: existingById.get(article.id)?.slug ?? slugifyRegistry(article.title, seen),
        title: article.title,
        description: article.description,
        subsumedIdeaIds: article.ideaIds,
        linkTargets: [],
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
      yield* pipeline.updateProgress(
        runId,
        "abstract",
        "completed",
        progressSteps(THEMES_ABSTRACT_STEP_LABELS, "build_articles", {
          completed: new Set(Object.keys(THEMES_ABSTRACT_STEP_LABELS)),
        }),
      );
      return validated;
    });

  const render = (vaultId: Uuid, runId: Uuid, validated: readonly ValidatedTopic[]) =>
    Effect.gen(function* () {
      const runner = yield* runnerFor(vaultId, runId);
      const prompt = yield* promptsFor(vaultId);
      yield* renderStep(runId, "write_articles", []);
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
        },
      );
      yield* renderStep(runId, "link_articles", ["write_articles"]);
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
          concurrency: config.compileEnrichConcurrency,
        },
      );
      yield* renderStep(runId, "index_articles", ["write_articles", "link_articles"]);
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
          body: withLinks(article.markdown, linked.linksOf.get(article.id) ?? [], hrefOf),
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
      yield* shortfall(
        runId,
        written.failedArticles,
        `of ${validated.length} articles could not be written`,
      );
      yield* shortfall(runId, linked.failedQuestions, "link questions failed");
      yield* options.rebuildWiki(vaultId, runId);
      yield* pipeline.updateProgress(
        runId,
        "render",
        "completed",
        progressSteps(THEMES_RENDER_STEP_LABELS, "index_articles", {
          completed: new Set(Object.keys(THEMES_RENDER_STEP_LABELS)),
        }),
      );
    });

  return { abstract, render };
};
