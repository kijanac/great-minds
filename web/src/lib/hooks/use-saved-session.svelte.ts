import type { SessionId } from "@great-minds/domain";
import { createQuery } from "@tanstack/svelte-query";

import { loadSession } from "$lib/api/sessions";
import { activeVault } from "$lib/hooks/use-vault.svelte";

export function useSavedSession(sessionId: () => SessionId | null) {
  return createQuery(() => ({
    queryKey: ["vault", activeVault.id, "session", sessionId()],
    staleTime: 0,
    gcTime: 0,
    queryFn: () => loadSession(sessionId()!),
    enabled: !!sessionId() && !!activeVault.id,
  }));
}
