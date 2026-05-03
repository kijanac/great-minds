import { useCallback, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type VaultOverview,
  type CreateVaultInput,
  createVault as apiCreateVault,
  fetchVaults,
  getVaultId,
  storeVaultId,
} from "@/api/client";

function subscribeVaultId(cb: () => void) {
  window.addEventListener("auth:changed", cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener("auth:changed", cb);
    window.removeEventListener("storage", cb);
  };
}

export function useActiveVaultId(): string | null {
  return useSyncExternalStore(subscribeVaultId, getVaultId);
}

export function useVaults() {
  return useQuery({
    queryKey: ["vaults"],
    queryFn: fetchVaults,
  });
}

export function useActiveVault() {
  const vaults = useVaults();
  const activeVaultId = useActiveVaultId();
  const activeVault = vaults.data?.find((b) => b.id === activeVaultId) ?? null;
  return { ...vaults, activeVault, activeVaultId };
}

export function useCreateVault() {
  const qc = useQueryClient();
  return useMutation<VaultOverview, Error, CreateVaultInput>({
    mutationFn: async (input) => {
      const vault = await apiCreateVault(input);
      storeVaultId(vault.id);
      return vault;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vaults"] });
    },
  });
}

export function useSwitchVault() {
  const qc = useQueryClient();
  return useCallback(
    (vaultId: string) => {
      if (vaultId === getVaultId()) return;
      storeVaultId(vaultId);
      qc.invalidateQueries({ queryKey: ["vault"] });
    },
    [qc],
  );
}
