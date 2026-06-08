import { and, asc, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import type { LocalContext } from "../db/client";
import { sourceDocuments } from "../db/schema";
import type { ListSourcesQuery } from "../schema/source";
import {
  SourceDocumentPageSchema,
  SourceDocumentSchema,
  type SourceDocument,
  type SourceDocumentPage,
} from "../schema/source";
import { loadCurrentWorkspace } from "./workspace";

export async function listSources(
  ctx: LocalContext,
  query: ListSourcesQuery,
): Promise<SourceDocumentPage> {
  return await ctx.db.transaction(async (tx) => {
    const workspace = await loadCurrentWorkspace(tx);
    const where = sourceFilter(workspace.vault.id, query);

    const rows = await tx
      .select()
      .from(sourceDocuments)
      .where(where)
      .orderBy(desc(sourceDocuments.updatedAt))
      .limit(query.limit)
      .offset(query.offset);

    const [totalRow] = await tx.select({ total: count() }).from(sourceDocuments).where(where);

    const facetRows = await tx
      .select({ value: sourceDocuments.sourceType, count: count() })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.vaultId, workspace.vault.id))
      .groupBy(sourceDocuments.sourceType)
      .orderBy(desc(count()), asc(sourceDocuments.sourceType));

    return SourceDocumentPageSchema.parse({
      items: rows.map(toSummary),
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total: totalRow?.total ?? 0,
      },
      facets: {
        sourceTypes: facetRows,
      },
    });
  });
}

type SourceDocumentMetadata = Omit<typeof sourceDocuments.$inferInsert, "vaultId">;

export async function upsertSourceDocumentMetadata(
  ctx: LocalContext,
  metadata: SourceDocumentMetadata,
): Promise<SourceDocument> {
  return await ctx.db.transaction(async (tx) => {
    const workspace = await loadCurrentWorkspace(tx);
    const values: typeof sourceDocuments.$inferInsert = {
      ...metadata,
      vaultId: workspace.vault.id,
      updatedAt: new Date(),
    };

    const [document] = await tx
      .insert(sourceDocuments)
      .values(values)
      .onConflictDoUpdate({
        target: [sourceDocuments.vaultId, sourceDocuments.filePath],
        set: values,
      })
      .returning();

    if (!document) throw new Error("Failed to upsert source document");

    return SourceDocumentSchema.parse(document);
  });
}

function sourceFilter(vaultId: string, query: ListSourcesQuery): SQL {
  const conditions: SQL[] = [eq(sourceDocuments.vaultId, vaultId)];

  if (query.sourceType) {
    conditions.push(eq(sourceDocuments.sourceType, query.sourceType));
  }

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
