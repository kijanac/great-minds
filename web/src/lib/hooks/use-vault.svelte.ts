import { browser } from "$app/environment";
import type { Uuid } from "@great-minds/domain";
import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";

import { createVault, fetchVaults, getVaultDetail, type CreateVaultInput } from "$lib/api/vaults";
import { getVaultId, storeVaultId } from "$lib/vault-selection";

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
  return createQuery(() => ({
    queryKey: ["vaults"],
    queryFn: fetchVaults,
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

export function switchVault(vaultId: Uuid): void {
  if (vaultId === getVaultId()) return;
  storeVaultId(vaultId);
}
