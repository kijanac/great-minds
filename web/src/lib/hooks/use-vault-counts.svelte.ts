import { createQuery } from "@tanstack/svelte-query";

import { fetchSourceDocuments } from "$lib/api/sources";
import { fetchWikiArticles } from "$lib/api/wiki";
import { activeVault } from "$lib/hooks/use-vault.svelte";

/** Count-only queries (limit=0) backing the home vault gauge. */
export function useVaultCounts() {
  const articles = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "article-count"],
    queryFn: () => fetchWikiArticles({ limit: 0 }),
    enabled: !!activeVault.id,
  }));

  const sources = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "source-count"],
    queryFn: () => fetchSourceDocuments({ limit: 0 }),
    enabled: !!activeVault.id,
  }));

  return {
    get articleTotal() {
      return articles.data?.pagination.total ?? null;
    },
    get sourceTotal() {
      return sources.data?.pagination.total ?? null;
    },
  };
}
