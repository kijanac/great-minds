import type { Uuid, WikiArticleOverview, WikiListQuery } from "@great-minds/domain";

import { api, run } from "./app";

export function fetchWikiArticles(vaultId: Uuid, query: WikiListQuery, signal?: AbortSignal) {
  return run(api.wiki.listWikiArticles({ params: { vault_id: vaultId }, query }), { signal });
}

export async function fetchAllWikiArticles(vaultId: Uuid, signal?: AbortSignal) {
  const all: WikiArticleOverview[] = [];
  for (;;) {
    const page = await fetchWikiArticles(vaultId, { limit: 200, offset: all.length }, signal);
    all.push(...page.items);
    if (page.items.length === 0 || all.length >= page.pagination.total) return all;
  }
}
