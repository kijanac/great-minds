import { z } from "zod";

import { apiFetch, readJson } from "./client";

const researchSuggestionSchema = z.object({
  topic: z.string(),
  source: z.string(),
  mentioned_in: z.array(z.string()),
  usage_count: z.number(),
  suggested_category: z.string(),
});

const contradictionSchema = z.object({
  description: z.string(),
  articles: z.array(z.string()),
});

const lintResponseSchema = z.object({
  research_suggestions: z.array(researchSuggestionSchema),
  contradictions: z.array(contradictionSchema),
  remaining_issues: z.number(),
});

export type ResearchSuggestion = z.infer<typeof researchSuggestionSchema>;
export type Contradiction = z.infer<typeof contradictionSchema>;
export type LintResponse = z.infer<typeof lintResponseSchema>;

export async function fetchLintResults(): Promise<LintResponse> {
  const res = await apiFetch("/lint");
  if (!res.ok) throw new Error("Failed to fetch lint results");
  return readJson(res, lintResponseSchema);
}

const recentArticleSchema = z.object({
  title: z.string(),
  file_path: z.string(),
  doc_kind: z.string(),
  updated_at: z.string(),
});

export type RecentArticle = z.infer<typeof recentArticleSchema>;

export async function fetchRecentArticles(limit: number = 10): Promise<RecentArticle[]> {
  const res = await apiFetch(`/wiki/recent?limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch recent articles");
  return readJson(res, z.array(recentArticleSchema));
}
