import { z } from "zod";

import { apiFetch, vaultPath, readJson } from "./client";
import { paginatedSchema } from "./schemas";

const orphanSchema = z.object({
  slug: z.string(),
  title: z.string(),
});

const unresolvedCitationSchema = z.object({
  source_slug: z.string(),
  source_title: z.string(),
  missing_slug: z.string(),
});

const unmentionedLinkSchema = z.object({
  source_slug: z.string(),
  source_title: z.string(),
  target_slug: z.string(),
  target_title: z.string(),
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
  const res = await apiFetch(vaultPath("/lint"));
  if (!res.ok) throw new Error("Failed to fetch lint results");
  return readJson(res, lintResponseSchema);
}

const wikiArticleOverviewSchema = z.object({
  file_path: z.string(),
  slug: z.string(),
  title: z.string(),
  precis: z.string().nullable(),
  updated_at: z.string().nullable(),
});
const recentArticlesSchema = paginatedSchema(wikiArticleOverviewSchema);

export type WikiArticleOverview = z.infer<typeof wikiArticleOverviewSchema>;

export async function fetchRecentArticles(limit: number = 10): Promise<WikiArticleOverview[]> {
  const res = await apiFetch(vaultPath(`/wiki/recent?limit=${limit}`));
  if (!res.ok) throw new Error("Failed to fetch recent articles");
  return (await readJson(res, recentArticlesSchema)).items;
}
