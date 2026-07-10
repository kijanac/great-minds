import { Database, sourceDocuments } from "@great-minds/database";
import {
  Forbidden,
  type SourceDocumentPage,
  type SourceDocumentSummary,
  type SourceListQuery,
  type Uuid
} from "@great-minds/domain";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { pageEnvelope, oneTotal } from "./pagination.ts";
import { VaultAccessService } from "./vaults.ts";

export type SourcesServiceShape = {
  readonly listSources: (
    userId: Uuid,
    vaultId: Uuid,
    query: SourceListQuery
  ) => Effect.Effect<SourceDocumentPage, Forbidden>;
};

export class SourcesService extends Context.Service<SourcesService, SourcesServiceShape>()(
  "@great-minds/server/SourcesService"
) {}

const DerivedExtras = Schema.Record(Schema.String, Schema.Unknown);
const decodeDerivedExtras = Schema.decodeUnknownSync(DerivedExtras);

const sourceSummary = (
  row: typeof sourceDocuments.$inferSelect
): SourceDocumentSummary => ({
  file_path: row.filePath,
  source_type: row.sourceType,
  title: row.title,
  author: row.author,
  published_date: row.publishedDate,
  url: row.url,
  origin: row.origin,
  genre: row.genre,
  precis: row.precis,
  tags: row.tags,
  derived_extras: decodeDerivedExtras(row.derivedExtras),
  updated_at: row.updatedAt.toISOString()
});

const sourceConditions = (vaultId: Uuid, query: SourceListQuery) => {
  const conditions: SQL[] = [eq(sourceDocuments.vaultId, vaultId)];
  if (query.source_type !== undefined && query.source_type !== "") {
    conditions.push(eq(sourceDocuments.sourceType, query.source_type));
  }
  if (query.search !== undefined && query.search !== "") {
    const pattern = `%${query.search}%`;
    const searchCondition = or(
      ilike(sourceDocuments.title, pattern),
      ilike(sourceDocuments.author, pattern)
    );
    if (searchCondition !== undefined) {
      conditions.push(searchCondition);
    }
  }
  return conditions;
};

export const SourcesServiceLive = Layer.effect(
  SourcesService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;

    return {
      listSources: (userId, vaultId, query) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const where = and(...sourceConditions(vaultId, query));
          const countRows = yield* db
            .select({ total: sql<number>`count(*)::int` })
            .from(sourceDocuments)
            .where(where)
            .pipe(Effect.orDie);
          const rows = yield* db
            .select()
            .from(sourceDocuments)
            .where(where)
            .orderBy(desc(sourceDocuments.updatedAt))
            .limit(query.limit)
            .offset(query.offset)
            .pipe(Effect.orDie);
          const facetRows = yield* db
            .select({
              value: sourceDocuments.sourceType,
              count: sql<number>`count(*)::int`
            })
            .from(sourceDocuments)
            .where(eq(sourceDocuments.vaultId, vaultId))
            .groupBy(sourceDocuments.sourceType)
            .orderBy(desc(sql`count(*)`))
            .pipe(Effect.orDie);

          return {
            ...pageEnvelope(rows.map(sourceSummary), query, oneTotal(countRows)),
            facets: {
              source_types: facetRows
            }
          };
        })
    } satisfies SourcesServiceShape;
  })
);
