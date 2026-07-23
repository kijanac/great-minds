import { createQuery } from "@tanstack/svelte-query";

import { readDocument } from "$lib/api/doc";
import { activeVault } from "$lib/hooks/use-vault.svelte";

export function useDocument(path: () => string | null) {
  return createQuery(() => ({
    queryKey: ["vault", activeVault.id, "doc", path()],
    queryFn: ({ signal }) => readDocument(path()!, signal),
    enabled: !!path() && !!activeVault.id,
  }));
}
