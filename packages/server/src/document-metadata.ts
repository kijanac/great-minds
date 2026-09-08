import type { sourceDocuments } from "@great-minds/database";
import type { SourceDocumentSummary, WikiArticleOverview } from "@great-minds/domain";
import { Schema } from "effect";

const decodeDerivedExtras = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

export const sourceSummary = (row: typeof sourceDocuments.$inferSelect): SourceDocumentSummary => ({
  id: row.id,
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
  updated_at: row.updatedAt,
});

export const wikiSlug = (filePath: string) => filePath.replace(/^wiki\//, "").replace(/\.md$/, "");

export const wikiOverview = (row: {
  readonly filePath: string;
  readonly title: string;
  readonly precis: string;
  readonly updatedAt: Date | null;
}): WikiArticleOverview => ({
  file_path: row.filePath,
  title: row.title,
  precis: row.precis,
  updated_at: row.updatedAt,
  slug: wikiSlug(row.filePath),
});
