import { and, asc, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import type { BackendDb } from "../db/context.js";
import { sourceDocuments } from "../db/schema.js";
import {
  SourceDocumentPageSchema,
  SourceDocumentSchema,
  type SourceDocument,
  type SourceDocumentPage,
  type SourceDocumentUpsert,
  type SourceListQuery,
} from "../domain/source.js";
import type { VaultScope } from "./workspace.js";
import { loadWorkspace } from "./workspace.js";

export async function listSources(
  db: BackendDb,
  scope: VaultScope,
  query: SourceListQuery,
): Promise<SourceDocumentPage> {
  await loadWorkspace(db, scope);
  const where = sourceFilter(scope.vaultId, query);

  const rows = await db
    .select()
    .from(sourceDocuments)
    .where(where)
    .orderBy(desc(sourceDocuments.updatedAt))
    .limit(query.limit)
    .offset(query.offset);

  const [totalRow] = await db.select({ total: count() }).from(sourceDocuments).where(where);

  const facetRows = await db
    .select({ value: sourceDocuments.sourceType, count: count() })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.vaultId, scope.vaultId))
    .groupBy(sourceDocuments.sourceType)
    .orderBy(desc(count()), asc(sourceDocuments.sourceType));

  return SourceDocumentPageSchema.parse({
    items: rows.map((row) => toSummary(SourceDocumentSchema.parse(row))),
    pagination: {
      limit: query.limit,
      offset: query.offset,
      total: totalRow?.total ?? 0,
    },
    facets: { sourceTypes: facetRows },
  });
}

export async function upsertSourceDocument(
  db: BackendDb,
  scope: VaultScope,
  metadata: SourceDocumentUpsert,
): Promise<SourceDocument> {
  await loadWorkspace(db, scope);

  const values: typeof sourceDocuments.$inferInsert = {
    ...metadata,
    vaultId: scope.vaultId,
    updatedAt: new Date(),
  };

  const [document] = await db
    .insert(sourceDocuments)
    .values(values)
    .onConflictDoUpdate({
      target: [sourceDocuments.vaultId, sourceDocuments.filePath],
      set: values,
    })
    .returning();

  if (!document) throw new Error("Failed to upsert source document");
  return SourceDocumentSchema.parse(document);
}

function sourceFilter(vaultId: string, query: SourceListQuery): SQL {
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

function toSummary(document: SourceDocument) {
  return {
    filePath: document.filePath,
    sourceType: document.sourceType,
    title: document.title,
    author: document.author,
    publishedDate: document.publishedDate,
    url: document.url,
    origin: document.origin,
    genre: document.genre,
    precis: document.precis,
    tags: document.tags,
    derivedExtras: document.derivedExtras,
    updatedAt: document.updatedAt,
  };
}
