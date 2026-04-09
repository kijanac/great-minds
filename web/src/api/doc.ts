import { z } from "zod";

import { apiFetch, readJson } from "./client";

const articleListSchema = z.array(z.string());

const documentResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export async function listArticles(): Promise<string[]> {
  const res = await apiFetch("/wiki");
  if (!res.ok) throw new Error(`Failed to list articles: ${res.status}`);
  return readJson(res, articleListSchema);
}

export async function readDocument(
  path: string,
  signal?: AbortSignal,
): Promise<{ path: string; content: string }> {
  const res = await apiFetch(`/doc/${path}`, { signal });
  if (!res.ok) throw new Error(`Document not found: ${path}`);
  return readJson(res, documentResponseSchema);
}
