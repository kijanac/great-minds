import { z } from "zod";

import { apiFetch, vaultPath, readJson } from "./client";
import { paginatedSchema } from "./schemas";

const wikiArticleSummarySchema = z.object({
  file_path: z.string(),
  slug: z.string(),
  title: z.string(),
  precis: z.string().nullable(),
  updated_at: z.string().nullable(),
});

const wikiArticleListSchema = paginatedSchema(wikiArticleSummarySchema);

export type WikiArticleSummary = z.infer<typeof wikiArticleSummarySchema>;
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
