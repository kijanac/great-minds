import { createQuery } from "@tanstack/svelte-query";

import { fetchLinks, readDocument, readPersonalDocument } from "$lib/api/doc";
import { activeVault } from "$lib/hooks/use-vault.svelte";

export function useDocument(path: () => string | null) {
  return createQuery(() => ({
    queryKey: ["vault", activeVault.id, "doc", path()],
    queryFn: ({ signal }) => readDocument(path()!, signal),
    enabled: !!path() && !!activeVault.id,
  }));
}

export function usePersonalDocument(path: () => string | null) {
  return createQuery(() => ({
    queryKey: ["me", "ref", path()],
    queryFn: ({ signal }) => readPersonalDocument(path()!, signal),
    enabled: !!path(),
  }));
}

export function useArticleLinks(path: () => string | null) {
  return createQuery(() => ({
    queryKey: ["vault", activeVault.id, "links", path()],
    queryFn: ({ signal }) => fetchLinks(path()!, signal),
    enabled: !!path()?.startsWith("wiki/") && !!activeVault.id,
  }));
}
