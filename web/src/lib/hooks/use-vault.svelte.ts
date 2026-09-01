import { browser } from "$app/environment";
import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";

import { createVault, fetchVaults, type CreateVaultInput } from "$lib/api/vaults";
import { getVaultId, storeVaultId } from "$lib/vault-selection";

class ActiveVaultSelection {
  id = $state<string | null>(null);
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
  return createQuery(() => ({
    queryKey: ["vaults"],
    queryFn: fetchVaults,
  }));
}

export function useCreateVault() {
  const queryClient = useQueryClient();
  return createMutation(() => ({
    mutationFn: async (input: CreateVaultInput) => {
      const vault = await createVault(input);
      storeVaultId(vault.id);
      return vault;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["vaults"] });
    },
  }));
}

export function switchVault(vaultId: string): void {
  if (vaultId === getVaultId()) return;
  storeVaultId(vaultId);
}
