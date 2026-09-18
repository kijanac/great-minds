import { browser } from "$app/environment";
import type { Uuid } from "@great-minds/domain";
import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";

import { createVault, fetchVaults, getVaultDetail, type CreateVaultInput } from "$lib/api/vaults";
import { auth } from "$lib/auth.svelte";
import { clearVaultId, getVaultId, storeVaultId } from "$lib/vault-selection";

class ActiveVaultSelection {
  id = $state<Uuid | null>(null);
  #initialized = false;

  #sync = () => {
    this.id = getVaultId();
  };

  initialize(): () => void {
    if (!browser) return () => {};
    this.#sync();
    if (this.#initialized) return () => {};

    this.#initialized = true;
    window.addEventListener("auth:changed", this.#sync);
    window.addEventListener("storage", this.#sync);
    return () => {
      window.removeEventListener("auth:changed", this.#sync);
      window.removeEventListener("storage", this.#sync);
      this.#initialized = false;
    };
  }
}

export const activeVault = new ActiveVaultSelection();

export function useVaults() {
  const vaults = createQuery(() => ({
    queryKey: ["vaults", auth.userId],
    queryFn: fetchVaults,
    enabled: auth.isAuthenticated,
  }));

  $effect(() => {
    if (!auth.isAuthenticated || !vaults.isSuccess) return;
    if (vaults.data.some((vault) => vault.id === activeVault.id)) return;
    const first = vaults.data[0];
    if (first) storeVaultId(first.id);
    else if (activeVault.id !== null) clearVaultId();
  });

  return vaults;
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
