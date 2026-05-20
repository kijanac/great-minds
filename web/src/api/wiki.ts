import { z } from "zod";

import { apiFetch, vaultPath, readJson } from "./client";
import { paginatedSchema } from "./schemas";

export const wikiArticleOverviewSchema = z.object({
  file_path: z.string(),
  slug: z.string(),
  title: z.string(),
  precis: z.string().nullable(),
  updated_at: z.string().nullable(),
});

const wikiArticleListSchema = paginatedSchema(wikiArticleOverviewSchema);

export type WikiArticleOverview = z.infer<typeof wikiArticleOverviewSchema>;
export type WikiArticleList = z.infer<typeof wikiArticleListSchema>;

export async function fetchWikiArticles(params?: {
  limit?: number;
  offset?: number;
}): Promise<WikiArticleList> {
  const query = new URLSearchParams();
  if (params?.limit !== undefined) query.set("limit", String(params.limit));
  if (params?.offset !== undefined) query.set("offset", String(params.offset));
  const qs = query.toString();
  const path = vaultPath(`/wiki${qs ? `?${qs}` : ""}`);
  const res = await apiFetch(path);
  if (!res.ok) throw new Error("Failed to fetch wiki articles");
  return readJson(res, wikiArticleListSchema);
}

/** Recency-ordered page (newest first) with the total count retained — used by
 *  the compile completion card to show what was just built. */
export async function fetchRecentWikiArticles(limit: number = 6): Promise<WikiArticleList> {
  const res = await apiFetch(vaultPath(`/wiki/recent?limit=${limit}`));
  if (!res.ok) throw new Error("Failed to fetch recent wiki articles");
  return readJson(res, wikiArticleListSchema);
}
