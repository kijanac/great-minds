import type { Uuid } from "@great-minds/domain";
import { createMutation, useQueryClient } from "@tanstack/svelte-query";

import { errorMessage } from "$lib/api/errors";
import { promoteReference } from "$lib/api/references";
import { invalidateSourceLists } from "$lib/hooks/use-library.svelte";

export function useReferencePromotion() {
  const queryClient = useQueryClient();
  const mutation = createMutation(() => ({
    mutationFn: ({ vaultId, path }: { vaultId: Uuid; path: string }) =>
      promoteReference(vaultId, path),
    onSuccess: (_, { vaultId }) => invalidateSourceLists(queryClient, vaultId),
  }));

  return {
    get error() {
      return mutation.error ? errorMessage(mutation.error) : null;
    },
    get pending() {
      return mutation.isPending;
    },
    promote: (vaultId: Uuid, path: string) => mutation.mutateAsync({ vaultId, path }),
  };
}
