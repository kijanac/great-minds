import { z } from "zod";

import { apiFetch, brainPath, readJson } from "./client";

const orphanSchema = z.object({
  slug: z.string(),
  title: z.string(),
});

const unresolvedCitationSchema = z.object({
  source_slug: z.string(),
  missing_slug: z.string(),
});

const unmentionedLinkSchema = z.object({
  source_slug: z.string(),
  target_slug: z.string(),
});

const lintResponseSchema = z.object({
  orphans: z.array(orphanSchema),
  dirty_topics: z.array(z.string()),
  unresolved_citations: z.array(unresolvedCitationSchema),
  unmentioned_links: z.array(unmentionedLinkSchema),
});

export type Orphan = z.infer<typeof orphanSchema>;
export type UnresolvedCitation = z.infer<typeof unresolvedCitationSchema>;
export type UnmentionedLink = z.infer<typeof unmentionedLinkSchema>;
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
