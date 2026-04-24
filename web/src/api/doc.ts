import { z } from "zod";

import { apiFetch, brainPath, readJson } from "./client";

const articleListSchema = z.array(z.string());

const documentSchema = z.object({
  id: z.string(),
  brain_id: z.string(),
  file_path: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  published_date: z.string().nullable(),
  url: z.string().nullable(),
  origin: z.string().nullable(),
  genre: z.string().nullable(),
  precis: z.string().nullable().default(null),
  compiled: z.boolean(),
  doc_kind: z.string(),
  source_type: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  extra_metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string().nullable().default(null),
  updated_at: z.string().nullable().default(null),
});

const documentResponseSchema = z.object({
  document: documentSchema,
  body: z.string(),
  archived: z.boolean().default(false),
  superseded_by: z.string().nullable().default(null),
});

export type Document = z.infer<typeof documentSchema>;
export type DocumentResponse = z.infer<typeof documentResponseSchema>;

export async function listArticles(): Promise<string[]> {
  const res = await apiFetch(brainPath("/wiki"));
  if (!res.ok) throw new Error(`Failed to list articles: ${res.status}`);
  return readJson(res, articleListSchema);
}

export async function readDocument(
  path: string,
  signal?: AbortSignal,
): Promise<DocumentResponse> {
  const res = await apiFetch(brainPath(`/doc/${path}`), { signal });
  if (!res.ok) throw new Error(`Document not found: ${path}`);
  return readJson(res, documentResponseSchema);
}
