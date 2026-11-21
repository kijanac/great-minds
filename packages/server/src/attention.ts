import {
  Database,
  pipelineRuns,
  sourceDocuments,
  topicLinks,
  topics,
  wikiArticles,
} from "@great-minds/database";
import { type AttentionReport, Forbidden, type Uuid } from "@great-minds/domain";
import { and, asc, count, desc, eq, gt, isNull, lte, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Effect, Layer } from "effect";

import { LEFT_OUT_MESSAGE, UNSEARCHABLE_MESSAGE } from "./pipeline-runs.ts";
import { VaultAccessService } from "./vaults.ts";

type AttentionServiceShape = {
  readonly report: (userId: Uuid, vaultId: Uuid) => Effect.Effect<AttentionReport, Forbidden>;
};

export class AttentionService extends Context.Service<AttentionService, AttentionServiceShape>()(
  "@great-minds/server/AttentionService",
) {}

export const AttentionServiceLive = Layer.effect(
  AttentionService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;

    return {
      report: (userId, vaultId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const [lastUpdate] = yield* db.query((d) =>
            d
              .select({ completedAt: pipelineRuns.completedAt, warnings: pipelineRuns.warnings })
              .from(pipelineRuns)
              .where(and(eq(pipelineRuns.vaultId, vaultId), eq(pipelineRuns.status, "completed")))
              .orderBy(desc(pipelineRuns.completedAt))
              .limit(1),
          );
          const updatedAt = lastUpdate?.completedAt ?? null;
          const warned = (message: string) =>
            (lastUpdate?.warnings ?? [])
              .filter((warning) => warning.message === message)
              .flatMap((warning) => warning.items);

          const unwritten = yield* db.query((d) =>
            d
              .select({ title: topics.title })
              .from(topics)
              .where(and(eq(topics.vaultId, vaultId), eq(topics.articleStatus, "no_article")))
              .orderBy(asc(sql`lower(${topics.title})`)),
          );

          const [added] = yield* db.query((d) =>
            d
              .select({ total: count() })
              .from(sourceDocuments)
              .where(
                and(
                  eq(sourceDocuments.vaultId, vaultId),
                  updatedAt === null ? undefined : gt(sourceDocuments.createdAt, updatedAt),
                ),
              ),
          );

          const unread =
            updatedAt === null
              ? []
              : yield* db.query((d) =>
                  d
                    .select({
                      id: sourceDocuments.id,
                      title: sql<string>`coalesce(${sourceDocuments.title}, ${sourceDocuments.filePath})`,
                    })
                    .from(sourceDocuments)
                    .where(
                      and(
                        eq(sourceDocuments.vaultId, vaultId),
                        isNull(sourceDocuments.precis),
                        lte(sourceDocuments.createdAt, updatedAt),
                      ),
                    )
                    .orderBy(
                      asc(
                        sql`lower(coalesce(${sourceDocuments.title}, ${sourceDocuments.filePath}))`,
                      ),
                    ),
                );

          const sourceTopic = alias(topics, "attention_source_topic");
          const targetTopic = alias(topics, "attention_target_topic");
          const sourceArticle = alias(wikiArticles, "attention_source_article");
          const targetArticle = alias(wikiArticles, "attention_target_article");
          const unplaced = yield* db.query((d) =>
            d
              .select({
                source_slug: sourceTopic.slug,
                source_title: sourceTopic.title,
                target_slug: targetTopic.slug,
                target_title: targetTopic.title,
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
              .orderBy(asc(sql`lower(${sourceTopic.slug})`), asc(sql`lower(${targetTopic.slug})`)),
          );

          return {
            unwritten_articles: unwritten.map((topic) => topic.title),
            new_sources: added?.total ?? 0,
            unread_sources: unread,
            left_out_files: warned(LEFT_OUT_MESSAGE),
            unsearchable_sources: warned(UNSEARCHABLE_MESSAGE),
            unplaced_links: unplaced,
          } satisfies AttentionReport;
        }),
    } satisfies AttentionServiceShape;
  }),
);
