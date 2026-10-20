import type { sourceDocuments } from "@great-minds/database";
import {
  SourceDocument,
  SourceDocumentSummary,
  type WikiArticleOverview,
} from "@great-minds/domain";
import { Effect, Schema, Struct } from "effect";

const sourceSummaryKeys = {
  file_path: "filePath",
  source_type: "sourceType",
  published_date: "publishedDate",
  derived_extras: "derivedExtras",
  updated_at: "updatedAt",
} as const;

const SourceSummaryFromRow = Schema.Struct(
  Struct.map(SourceDocumentSummary.fields, Schema.toType),
).pipe(Schema.encodeKeys(sourceSummaryKeys));

const SourceDocumentFromRow = Schema.Struct({
  ...Struct.map(SourceDocument.fields, Schema.toType),
  kind: SourceDocument.fields.kind.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed("source")),
  ),
}).pipe(
  Schema.encodeKeys({
    ...sourceSummaryKeys,
    vault_id: "vaultId",
    body_hash: "bodyHash",
    canonical_url: "canonicalUrl",
    provenance_session_id: "provenanceSessionId",
    provenance_exchange_id: "provenanceExchangeId",
    provenance_session_query: "provenanceSessionQuery",
    provenance_source_doc_path: "provenanceSourceDocPath",
    provenance_source_anchor: "provenanceSourceAnchor",
    provenance_source_paragraph_index: "provenanceSourceParagraphIndex",
    provenance_anchored_to: "provenanceAnchoredTo",
    provenance_anchored_section: "provenanceAnchoredSection",
    provenance_intent: "provenanceIntent",
    created_at: "createdAt",
  }),
);

export const readSourceSummary = (row: typeof sourceDocuments.$inferSelect) =>
  Schema.decodeUnknownEffect(SourceSummaryFromRow)(row).pipe(Effect.orDie);

export const readSourceDocument = (row: typeof sourceDocuments.$inferSelect) =>
  Schema.decodeUnknownEffect(SourceDocumentFromRow)(row).pipe(Effect.orDie);

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
