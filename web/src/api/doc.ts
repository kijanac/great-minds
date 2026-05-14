import { z } from "zod";

import { apiFetch, vaultPath, readJson } from "./client";

export const sourceDocumentSchema = z.object({
  kind: z.literal("source"),
  id: z.string(),
  vault_id: z.string(),
  file_path: z.string(),
  body_hash: z.string(),
  source_type: z.string(),
  etag: z.string().nullable(),
  url: z.string().nullable(),
  origin: z.string().nullable(),
  // Provenance (set at ingest for session/user-suggestion docs; null for source_type='document'):
  provenance_session_id: z.string().nullable(),
  provenance_exchange_id: z.string().nullable(),
  provenance_session_query: z.string().nullable(),
  provenance_source_doc_path: z.string().nullable(),
  provenance_source_anchor: z.string().nullable(),
  provenance_source_paragraph_index: z.number().nullable(),
  provenance_anchored_to: z.string().nullable(),
  provenance_anchored_section: z.string().nullable(),
  provenance_intent: z.string().nullable(),
  // LLM-derived (null until first compile):
  title: z.string().nullable(),
  precis: z.string().nullable(),
  author: z.string().nullable(),
  published_date: z.string().nullable(),
  genre: z.string().nullable(),
  tags: z.array(z.string()),
  derived_extras: z.record(z.string(), z.unknown()),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export const wikiArticleSchema = z.object({
  kind: z.literal("wiki"),
  id: z.string(),
  vault_id: z.string(),
  topic_id: z.string(),
  file_path: z.string(),
  body_hash: z.string(),
  title: z.string(),
  precis: z.string(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

const articleSchema = z.discriminatedUnion("kind", [sourceDocumentSchema, wikiArticleSchema]);

const documentResponseSchema = z.object({
  article: articleSchema,
  body: z.string(),
  archived: z.boolean(),
  superseded_by: z.string().nullable(),
});

export type SourceDocument = z.infer<typeof sourceDocumentSchema>;
export type WikiArticle = z.infer<typeof wikiArticleSchema>;
export type Article = SourceDocument | WikiArticle;
export type DocumentResponse = z.infer<typeof documentResponseSchema>;

/** Normalized metadata across both article types for DocHeader display. */
export function articleMeta(article: Article) {
  if (article.kind === "wiki") {
    return {
      title: article.title,
      author: null as string | null,
      published_date: null as string | null,
      url: null as string | null,
      origin: null as string | null,
      genre: null as string | null,
      precis: article.precis || null,
      source_type: null as string | null,
      tags: [] as string[],
      derived_extras: {} as Record<string, unknown>,
    };
  }
  return {
    title: article.title,
    author: article.author,
    published_date: article.published_date,
    url: article.url,
    origin: article.origin,
    genre: article.genre,
    precis: article.precis,
    source_type: article.source_type,
    tags: article.tags,
    derived_extras: article.derived_extras,
  };
}

export async function readDocument(path: string, signal?: AbortSignal): Promise<DocumentResponse> {
  const res = await apiFetch(vaultPath(`/doc/${path}`), { signal });
  if (!res.ok) throw new Error(`Document not found: ${path}`);
  return readJson(res, documentResponseSchema);
}
