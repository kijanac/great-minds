import type { WikiArticleOverview, WikiArticlePage } from "@great-minds/domain";

import { api, run } from "./app";
import { selectedVault } from "./selected-vault";

export type { WikiArticleOverview, WikiArticlePage };

export function fetchWikiArticles(params: {
  contains?: string;
  tag?: string;
  sort?: "title" | "linked";
  limit: number;
  offset?: number;
}): Promise<WikiArticlePage> {
  const query = {
    limit: params.limit,
    offset: params.offset ?? 0,
    ...(params.contains !== undefined ? { contains: params.contains } : {}),
    ...(params.tag !== undefined ? { tag: params.tag } : {}),
    ...(params.sort !== undefined ? { sort: params.sort } : {}),
  };
  return run(api.wiki.listWikiArticles({ params: { vault_id: selectedVault() }, query }));
}

export async function fetchAllWikiArticles(): Promise<WikiArticleOverview[]> {
  const all: WikiArticleOverview[] = [];
  for (;;) {
    const page = await fetchWikiArticles({ limit: 200, offset: all.length });
    all.push(...page.items);
    if (page.items.length === 0 || all.length >= page.pagination.total) return all;
  }
}
