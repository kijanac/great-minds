import type { sourceDocuments } from "@great-minds/database";
import type {
  SourceDocument,
  SourceDocumentSummary,
  WikiArticleOverview,
} from "@great-minds/domain";

type SourceRow = typeof sourceDocuments.$inferSelect;

export const sourceSummary = (row: SourceRow): SourceDocumentSummary => ({
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
  derived_extras: row.derivedExtras,
  updated_at: row.updatedAt,
});

export const sourceDocument = (row: SourceRow): SourceDocument => ({
  ...sourceSummary(row),
  kind: "source",
  vault_id: row.vaultId,
  body_hash: row.bodyHash,
  etag: row.etag,
  canonical_url: row.canonicalUrl,
  provenance_session_id: row.provenanceSessionId,
  provenance_exchange_id: row.provenanceExchangeId,
  provenance_session_query: row.provenanceSessionQuery,
  provenance_source_doc_path: row.provenanceSourceDocPath,
  provenance_source_anchor: row.provenanceSourceAnchor,
  provenance_anchored_to: row.provenanceAnchoredTo,
  provenance_anchored_section: row.provenanceAnchoredSection,
  provenance_intent: row.provenanceIntent,
  created_at: row.createdAt,
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
