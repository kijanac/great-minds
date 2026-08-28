import { z } from "zod";

import { apiFetch, paginationParams, vaultPath, vaultPathFor, readJson } from "./client";
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
  contains?: string;
  tag?: string;
}): Promise<WikiArticleList> {
  const query = paginationParams(params);
  if (params?.contains) query.set("contains", params.contains);
  if (params?.tag) query.set("tag", params.tag);
  const qs = query.toString();
  const path = vaultPath(`/wiki${qs ? `?${qs}` : ""}`);
  const res = await apiFetch(path);
  if (!res.ok) throw new Error("Failed to fetch wiki articles");
  return readJson(res, wikiArticleListSchema);
}

/** Articles produced by a given pipeline run — drives the compile completion
 *  card's "what this run built" delta. */
export async function fetchArticlesByRun(
  runId: string,
  limit: number = 8,
  vaultId?: string,
): Promise<WikiArticleList> {
  const path = `/wiki?run=${runId}&limit=${limit}`;
  const res = await apiFetch(vaultId ? vaultPathFor(vaultId, path) : vaultPath(path));
  if (!res.ok) throw new Error("Failed to fetch articles for run");
  return readJson(res, wikiArticleListSchema);
}
