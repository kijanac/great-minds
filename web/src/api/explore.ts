import { z } from "zod";

import { apiFetch, brainPath, readJson } from "./client";

const researchSuggestionSchema = z.object({
  topic: z.string(),
  mentioned_in: z.array(z.string()),
  usage_count: z.number(),
});

const contradictionSchema = z.object({
  description: z.string(),
  articles: z.array(z.string()),
});

const orphanSchema = z.object({
  slug: z.string(),
  canonical_label: z.string(),
});

const lintResponseSchema = z.object({
  research_suggestions: z.array(researchSuggestionSchema),
  orphans: z.array(orphanSchema),
  dirty_concepts: z.array(z.string()),
  contradictions: z.array(contradictionSchema),
});

export type ResearchSuggestion = z.infer<typeof researchSuggestionSchema>;
export type Contradiction = z.infer<typeof contradictionSchema>;
export type Orphan = z.infer<typeof orphanSchema>;
export type LintResponse = z.infer<typeof lintResponseSchema>;

export async function fetchLintResults(): Promise<LintResponse> {
  const res = await apiFetch(brainPath("/lint"));
  if (!res.ok) throw new Error("Failed to fetch lint results");
  return readJson(res, lintResponseSchema);
}

const recentArticleSchema = z.object({
  title: z.string(),
  file_path: z.string(),
  doc_kind: z.string(),
  updated_at: z.string().nullable(),
});

export type RecentArticle = z.infer<typeof recentArticleSchema>;

export async function fetchRecentArticles(limit: number = 10): Promise<RecentArticle[]> {
  const res = await apiFetch(brainPath(`/wiki/recent?limit=${limit}`));
  if (!res.ok) throw new Error("Failed to fetch recent articles");
  return readJson(res, z.array(recentArticleSchema));
}
