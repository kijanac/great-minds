import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useLocalApp } from "@/local/app-provider";
import type { CreateVaultCommand, Vault } from "@/local/schema/vault";
import { localApi } from "@/local/worker/client";

export function useActiveVaultId(): string {
  const { workspace } = useLocalApp();
  return workspace.appState.currentVaultId;
}

export function useVaults() {
  const { workspace } = useLocalApp();

  return useQuery({
    queryKey: ["vaults"],
    queryFn: () => localApi.listVaults(),
    initialData: [workspace.vault],
  });
}

export function useActiveVault() {
  const vaults = useVaults();
  const { workspace } = useLocalApp();
  const activeVaultId = workspace.appState.currentVaultId;
  const activeVault = vaults.data.find((vault) => vault.id === activeVaultId) ?? workspace.vault;

  return { ...vaults, activeVault, activeVaultId };
}

export function useCreateVault() {
  const qc = useQueryClient();
  const { createVault } = useLocalApp();

  return useMutation<Vault, Error, CreateVaultCommand>({
    mutationFn: async (input) => {
      const workspace = await createVault(input);
      return workspace.vault;
    },
    onSuccess: (vault) => {
      qc.setQueryData<Vault[]>(["vaults"], (current) => {
        const vaults = current ?? [];
        return vaults.some((item) => item.id === vault.id) ? vaults : [...vaults, vault];
      });
      qc.invalidateQueries({ queryKey: ["vault"] });
    },
  });
}

export function useSwitchVault() {
  const qc = useQueryClient();
  const { switchVault } = useLocalApp();

  return useCallback(
    (vaultId: string) => {
      void switchVault(vaultId).then(() => {
        qc.invalidateQueries({ queryKey: ["vault"] });
      });
    },
    [qc, switchVault],
  );
}
