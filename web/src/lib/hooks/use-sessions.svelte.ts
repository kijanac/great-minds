import { createInfiniteQuery, createQuery } from "@tanstack/svelte-query";

import { nextPageOffset } from "$lib/api/pagination";
import { listSessions } from "$lib/api/sessions";
import { activeVault } from "$lib/hooks/use-vault.svelte";

export function useSessions() {
  return createQuery(() => ({
    queryKey: ["vault", activeVault.id, "sessions"],
    queryFn: () => listSessions(),
    enabled: !!activeVault.id,
  }));
}

export function useInfiniteSessions(pageSize: number = 50) {
  return createInfiniteQuery(() => ({
    queryKey: ["vault", activeVault.id, "sessions", "infinite"],
    queryFn: ({ pageParam }) => listSessions({ limit: pageSize, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => nextPageOffset(lastPage),
    enabled: !!activeVault.id,
  }));
}
