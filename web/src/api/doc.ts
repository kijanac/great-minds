import { z } from "zod";

import { apiFetch, vaultPath, readJson } from "./client";

export const sourceDocumentSchema = z.object({
  id: z.string(),
  vault_id: z.string(),
  file_path: z.string(),
  body_hash: z.string(),
  compiled: z.boolean(),
  metadata: z.object({
    title: z.string(),
    author: z.string().nullable(),
    published_date: z.string().nullable(),
    url: z.string().nullable(),
    origin: z.string().nullable(),
    genre: z.string().nullable(),
    precis: z.string().nullable(),
    source_type: z.string().nullable(),
    tags: z.array(z.string()),
    extra_metadata: z.record(z.string(), z.unknown()),
  }),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export const wikiArticleSchema = z.object({
  id: z.string(),
  vault_id: z.string(),
  topic_id: z.string(),
  file_path: z.string(),
  body_hash: z.string(),
  title: z.string(),
  precis: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

const articleSchema = z.union([sourceDocumentSchema, wikiArticleSchema]);

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

export function isWiki(article: Article): article is WikiArticle {
  return "topic_id" in article;
}

export function isSource(article: Article): article is SourceDocument {
  return "compiled" in article;
}

/** Normalized metadata across both article types for DocHeader display. */
export function articleMeta(article: Article) {
  if (isWiki(article)) {
    return {
      title: article.title || "",
      author: null as string | null,
      published_date: null as string | null,
      url: null as string | null,
      origin: null as string | null,
      genre: null as string | null,
      precis: article.precis ?? null,
      source_type: null as string | null,
      tags: [] as string[],
      extra_metadata: {} as Record<string, unknown>,
    };
  }
  return article.metadata;
}

export async function readDocument(path: string, signal?: AbortSignal): Promise<DocumentResponse> {
  const res = await apiFetch(vaultPath(`/doc/${path}`), { signal });
  if (!res.ok) throw new Error(`Document not found: ${path}`);
  return readJson(res, documentResponseSchema);
}
