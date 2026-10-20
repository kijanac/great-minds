import type { SessionId, Uuid } from "@great-minds/domain";
import { createInfiniteQuery, createMutation, createQuery } from "@tanstack/svelte-query";

import { nextPageOffset } from "$lib/api/pagination";
import { errorMessage } from "$lib/api/errors";
import { listSessions, promoteExchange } from "$lib/api/sessions";
import { activeVault } from "$lib/hooks/use-vault.svelte";

export function useSessions() {
  return createQuery(() => ({
    queryKey: ["vault", activeVault.id, "sessions"],
    queryFn: () => listSessions(),
    enabled: !!activeVault.id,
  }));
}

export function useExchangePromotion() {
  const mutation = createMutation(() => ({
    mutationFn: ({ sessionId, exchangeId }: { sessionId: SessionId; exchangeId: Uuid }) =>
      promoteExchange(sessionId, exchangeId),
  }));

  return {
    get result() {
      return mutation.data;
    },
    get pending() {
      return mutation.isPending;
    },
    get error() {
      return mutation.error
        ? errorMessage(mutation.error, "Couldn't add this answer to the vault.")
        : null;
    },
    promote: (sessionId: SessionId, exchangeId: Uuid) => mutation.mutate({ sessionId, exchangeId }),
  };
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
