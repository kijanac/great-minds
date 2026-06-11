import { Effect } from "effect";
import { and, asc, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import type { BackendDb } from "@great-minds/db/context";
import { sourceDocuments } from "@great-minds/db/schema";
import type { VaultId } from "@great-minds/domain/vault";
import {
  SourceDocumentPageSchema,
  SourceDocumentSchema,
  type SourceDocument,
  type SourceDocumentPage,
  type SourceDocumentUpsert,
  type SourceListQuery,
} from "@great-minds/domain/source";
import { firstOrDie, parseOrDie } from "./effect-helpers.js";
import { loadWorkspace, VaultUnavailable, type VaultScope } from "./workspace.js";

export function listSources(
  db: BackendDb,
  scope: VaultScope,
  query: SourceListQuery,
): Effect.Effect<SourceDocumentPage, VaultUnavailable> {
  return Effect.gen(function* () {
    yield* loadWorkspace(db, scope);
    const where = sourceFilter(scope.vaultId, query);

    const rows = yield* db
      .select({
        filePath: sourceDocuments.filePath,
        sourceType: sourceDocuments.sourceType,
        title: sourceDocuments.title,
        author: sourceDocuments.author,
        publishedDate: sourceDocuments.publishedDate,
        url: sourceDocuments.url,
        origin: sourceDocuments.origin,
        genre: sourceDocuments.genre,
        precis: sourceDocuments.precis,
        tags: sourceDocuments.tags,
        derivedExtras: sourceDocuments.derivedExtras,
        updatedAt: sourceDocuments.updatedAt,
      })
      .from(sourceDocuments)
      .where(where)
      .orderBy(desc(sourceDocuments.updatedAt))
      .limit(query.limit)
      .offset(query.offset)
      .pipe(Effect.orDie);

    const totalRows = yield* db
      .select({ total: count() })
      .from(sourceDocuments)
      .where(where)
      .pipe(Effect.orDie);
    const totalRow = yield* firstOrDie(totalRows, "Failed to count source documents");

    const facetRows = yield* db
      .select({ value: sourceDocuments.sourceType, count: count() })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.vaultId, scope.vaultId))
      .groupBy(sourceDocuments.sourceType)
      .orderBy(desc(count()), asc(sourceDocuments.sourceType))
      .pipe(Effect.orDie);

    return yield* parseOrDie(() =>
      SourceDocumentPageSchema.parse({
        items: rows,
        pagination: {
          limit: query.limit,
          offset: query.offset,
          total: totalRow.total,
        },
        facets: { sourceTypes: facetRows },
      }),
    );
  });
}

export function upsertSourceDocument(
  db: BackendDb,
  scope: VaultScope,
  metadata: SourceDocumentUpsert,
): Effect.Effect<SourceDocument, VaultUnavailable> {
  return Effect.gen(function* () {
    yield* loadWorkspace(db, scope);

    const values = { ...metadata, vaultId: scope.vaultId, updatedAt: new Date() };

    const rows = yield* db
      .insert(sourceDocuments)
      .values(values)
      .onConflictDoUpdate({
        target: [sourceDocuments.vaultId, sourceDocuments.filePath],
        set: values,
      })
      .returning()
      .pipe(Effect.orDie);

    const document = yield* firstOrDie(rows, "Failed to upsert source document");
    return yield* parseOrDie(() => SourceDocumentSchema.parse(document));
  });
}

function sourceFilter(vaultId: VaultId, query: SourceListQuery): SQL {
  const conditions: SQL[] = [eq(sourceDocuments.vaultId, vaultId)];

  if (query.sourceType) conditions.push(eq(sourceDocuments.sourceType, query.sourceType));

  if (query.search) {
    const pattern = `%${query.search}%`;
    conditions.push(
      or(
        ilike(sourceDocuments.filePath, pattern),
        ilike(sourceDocuments.title, pattern),
        ilike(sourceDocuments.author, pattern),
        ilike(sourceDocuments.origin, pattern),
        ilike(sourceDocuments.precis, pattern),
      )!,
    );
  }

  return and(...conditions)!;
}

