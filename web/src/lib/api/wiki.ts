import { Uuid, type WikiArticleOverview, type WikiArticlePage } from "@great-minds/domain";
import { Schema } from "effect";

import { getVaultId } from "../vault-selection";

import { api, run } from "./app";

export type { WikiArticleOverview, WikiArticlePage };

const uuid = Schema.decodeSync(Uuid);

function selectedVault(vaultId?: string): Uuid {
  const id = vaultId ?? getVaultId();
  if (id === null) throw new Error("No vault selected");
  return uuid(id);
}

export async function fetchWikiArticles(params: {
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

export async function fetchArticlesByRun(
  runId: string,
  limit: number = 8,
  vaultId?: string,
): Promise<WikiArticlePage> {
  return run(
    api.wiki.listWikiArticles({
      params: { vault_id: selectedVault(vaultId) },
      query: { run: uuid(runId), limit, offset: 0 },
    }),
  );
}
