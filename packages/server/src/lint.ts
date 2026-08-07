import { Database, topicLinks, topics, wikiArticles } from "@great-minds/database";
import { Forbidden, type LintReport, type Uuid } from "@great-minds/domain";
import { and, asc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Effect, Layer } from "effect";

import { VaultAccessService } from "./vaults.ts";

const WIKI_INDEX_PATH = "wiki/_index.md";

const wikiSlug = (path: string) => {
  if (!path.startsWith("wiki/") || !path.endsWith(".md")) {
    throw new Error(`invalid wiki article path: ${path}`);
  }
  return path.slice("wiki/".length, -".md".length);
};

type LintServiceShape = {
  readonly report: (userId: Uuid, vaultId: Uuid) => Effect.Effect<LintReport, Forbidden>;
};

export class LintService extends Context.Service<LintService, LintServiceShape>()(
  "@great-minds/server/LintService",
) {}

export const LintServiceLive = Layer.effect(
  LintService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;

    return {
      report: (userId, vaultId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const orphans = yield* db.query((d) => d
            .select({
              filePath: wikiArticles.filePath,
              title: wikiArticles.title,
              precis: wikiArticles.precis,
              updatedAt: wikiArticles.updatedAt,
            })
            .from(wikiArticles)
            .where(
              and(
                eq(wikiArticles.vaultId, vaultId),
                ne(wikiArticles.filePath, WIKI_INDEX_PATH),
                eq(wikiArticles.archived, false),
                sql`NOT EXISTS (
                  SELECT 1 FROM backlinks backlink
                  WHERE backlink.target_article_id = ${wikiArticles.id}
                )`,
              ),
            )
            .orderBy(asc(sql`lower(${wikiArticles.title})`)));

          const dirty = yield* db.query((d) => d
            .select({ topicId: topics.topicId })
            .from(topics)
            .where(
              and(
                eq(topics.vaultId, vaultId),
                ne(topics.articleStatus, "archived"),
                isNotNull(topics.compiledFromHash),
                or(
                  isNull(topics.renderedFromHash),
                  ne(topics.renderedFromHash, topics.compiledFromHash),
                ),
              ),
            ));

          const sourceTopic = alias(topics, "lint_source_topic");
          const targetTopic = alias(topics, "lint_target_topic");
          const sourceArticle = alias(wikiArticles, "lint_source_article");
          const targetArticle = alias(wikiArticles, "lint_target_article");
          const unmentioned = yield* db.query((d) => d
            .select({
              sourceSlug: sourceTopic.slug,
              sourceTitle: sourceTopic.title,
              targetSlug: targetTopic.slug,
              targetTitle: targetTopic.title,
            })
            .from(topicLinks)
            .innerJoin(sourceTopic, eq(sourceTopic.topicId, topicLinks.sourceTopicId))
            .innerJoin(targetTopic, eq(targetTopic.topicId, topicLinks.targetTopicId))
            .innerJoin(sourceArticle, eq(sourceArticle.topicId, sourceTopic.topicId))
            .innerJoin(targetArticle, eq(targetArticle.topicId, targetTopic.topicId))
            .where(
              and(
                eq(sourceTopic.vaultId, vaultId),
                eq(sourceTopic.articleStatus, "rendered"),
                eq(targetTopic.articleStatus, "rendered"),
                ne(topicLinks.sourceTopicId, topicLinks.targetTopicId),
                sql`NOT EXISTS (
                  SELECT 1 FROM backlinks backlink
                  WHERE backlink.source_article_id = ${sourceArticle.id}
                    AND backlink.target_article_id = ${targetArticle.id}
                )`,
              ),
            )
            .orderBy(asc(sql`lower(${sourceTopic.slug})`), asc(sql`lower(${targetTopic.slug})`)));

          return {
            orphans: orphans.map((row) => ({
              file_path: row.filePath,
              title: row.title,
              precis: row.precis,
              updated_at: row.updatedAt.toISOString(),
              slug: wikiSlug(row.filePath),
            })),
            dirty_topics: dirty.map((row) => row.topicId as Uuid),
            unmentioned_links: unmentioned.map((row) => ({
              source_slug: row.sourceSlug,
              source_title: row.sourceTitle,
              target_slug: row.targetSlug,
              target_title: row.targetTitle,
            })),
          } satisfies LintReport;
        }),
    } satisfies LintServiceShape;
  }),
);
