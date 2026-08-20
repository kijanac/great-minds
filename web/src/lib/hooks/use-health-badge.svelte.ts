import { createQuery } from "@tanstack/svelte-query";

import { fetchLintResults } from "$lib/api/lint";
import { activeVault } from "$lib/hooks/use-vault.svelte";

export function useHealthBadge() {
  return createQuery(() => ({
    queryKey: ["vault", activeVault.id, "health-count"],
    queryFn: fetchLintResults,
    enabled: !!activeVault.id,
  }));
}
