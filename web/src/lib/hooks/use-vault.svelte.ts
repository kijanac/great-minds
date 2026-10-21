import type { Uuid } from "@great-minds/domain";
import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";

import { createVault, fetchVaults, getVaultDetail, type CreateVaultInput } from "$lib/api/vaults";
import { auth } from "$lib/auth.svelte";
import { getVaultId, storeVaultId } from "$lib/vault-selection";
import { windowSync } from "$lib/window-sync";

class ActiveVaultSelection {
  id = $state<Uuid | null>(null);

  initialize = windowSync(["auth:changed", "storage"], () => {
    this.id = getVaultId();
  });
}

export const activeVault = new ActiveVaultSelection();

export function useVaults() {
  return createQuery(() => ({
    queryKey: ["vaults", auth.userId],
    queryFn: ({ signal }) => fetchVaults(signal),
    enabled: auth.isAuthenticated,
  }));
}

export function useVaultDetail(vaultId: () => Uuid | null, enabled: () => boolean = () => true) {
  return createQuery(() => {
    const id = vaultId();
    return {
      queryKey: ["vault", id, "detail"],
      queryFn: () => getVaultDetail(id!),
      enabled: id !== null && enabled(),
    };
  });
}

export function useCreateVault() {
  const queryClient = useQueryClient();
  return createMutation(() => ({
    mutationFn: (input: CreateVaultInput) => createVault(input),
    onSuccess: async (vault) => {
      await queryClient.invalidateQueries({ queryKey: ["vaults"] });
      storeVaultId(vault.id);
    },
  }));
}

export function switchVault(vaultId: Uuid): void {
  if (vaultId === getVaultId()) return;
  storeVaultId(vaultId);
}
