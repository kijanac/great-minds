import { createMutation } from "@tanstack/svelte-query";

import { promoteReference } from "$lib/api/references";

export function useReferencePromotion() {
  const mutation = createMutation(() => ({
    mutationFn: ({ vaultId, path }: { vaultId: string; path: string }) =>
      promoteReference(vaultId, path),
  }));

  return {
    get error() {
      return mutation.error instanceof Error ? mutation.error.message : null;
    },
    get pending() {
      return mutation.isPending;
    },
    promote: (vaultId: string, path: string) => mutation.mutateAsync({ vaultId, path }),
  };
}
