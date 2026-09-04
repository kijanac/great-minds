import type { Uuid, WikiArticleOverview, WikiArticlePage } from "@great-minds/domain";

import { api, run } from "./app";
import { selectedVault } from "./selected-vault";

export type { WikiArticleOverview, WikiArticlePage };

export function fetchWikiArticles(params: {
  contains?: string;
  tag?: string;
  limit: number;
  offset?: number;
}): Promise<WikiArticlePage> {
  const query = {
    limit: params.limit,
    offset: params.offset ?? 0,
    ...(params.contains !== undefined ? { contains: params.contains } : {}),
    ...(params.tag !== undefined ? { tag: params.tag } : {}),
  };
  return run(api.wiki.listWikiArticles({ params: { vault_id: selectedVault() }, query }));
}

export function fetchArticlesByRun(
  runId: Uuid,
  limit: number = 8,
  vaultId?: Uuid,
): Promise<WikiArticlePage> {
  return run(
    api.wiki.listWikiArticles({
      params: { vault_id: selectedVault(vaultId) },
      query: { run: runId, limit, offset: 0 },
    }),
  );
}
