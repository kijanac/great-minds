import { Database, wikiArticles } from "@great-minds/database";
import {
  Forbidden,
  type PageParams,
  type Uuid,
  type WikiArticleOverview,
  type WikiArticlePage,
  type WikiListQuery
} from "@great-minds/domain";
import { and, asc, desc, eq, ne, sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { pageEnvelope, oneTotal } from "./pagination.ts";
import { VaultAccessService } from "./vaults.ts";

export type WikiServiceShape = {
  readonly listArticles: (
    userId: Uuid,
    vaultId: Uuid,
    query: WikiListQuery
  ) => Effect.Effect<WikiArticlePage, Forbidden>;
  readonly listRecent: (
    userId: Uuid,
    vaultId: Uuid,
    params: PageParams
  ) => Effect.Effect<WikiArticlePage, Forbidden>;
};

export class WikiService extends Context.Service<WikiService, WikiServiceShape>()(
  "@great-minds/server/WikiService"
) {}

const WIKI_INDEX_PATH = "wiki/_index.md";

const slugFromWikiPath = (filePath: string) => {
  if (!filePath.startsWith("wiki/") || !filePath.endsWith(".md")) {
    throw new Error(`invalid wiki article path: ${filePath}`);
  }
  return filePath.slice("wiki/".length, -".md".length);
};

const articleOverview = (row: typeof wikiArticles.$inferSelect): WikiArticleOverview => ({
  file_path: row.filePath,
  title: row.title,
  precis: row.precis,
  updated_at: row.updatedAt.toISOString(),
  slug: slugFromWikiPath(row.filePath)
});

const liveArticleConditions = (vaultId: Uuid, renderRunId?: Uuid) => {
  const conditions: SQL[] = [
    eq(wikiArticles.vaultId, vaultId),
    eq(wikiArticles.archived, false),
    ne(wikiArticles.filePath, WIKI_INDEX_PATH)
  ];
  if (renderRunId !== undefined) {
    conditions.push(eq(wikiArticles.renderRunId, renderRunId));
  }
  return conditions;
};

export const WikiServiceLive = Layer.effect(
  WikiService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;

    const listPage = (params: PageParams, conditions: readonly SQL[], orderBy: SQL) =>
      Effect.gen(function* () {
        const where = and(...conditions);
        const countRows = yield* db
          .select({ total: sql<number>`count(*)::int` })
          .from(wikiArticles)
          .where(where)
          .pipe(Effect.orDie);
        const rows = yield* db
          .select()
          .from(wikiArticles)
          .where(where)
          .orderBy(orderBy)
          .limit(params.limit)
          .offset(params.offset)
          .pipe(Effect.orDie);
        return pageEnvelope(rows.map(articleOverview), params, oneTotal(countRows));
      });

    return {
      listArticles: (userId, vaultId, query) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          return yield* listPage(
            query,
            liveArticleConditions(vaultId, query.run),
            asc(sql`lower(${wikiArticles.title})`)
          );
        }),
      listRecent: (userId, vaultId, params) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          return yield* listPage(
            params,
            liveArticleConditions(vaultId),
            desc(wikiArticles.updatedAt)
          );
        })
    } satisfies WikiServiceShape;
  })
);
