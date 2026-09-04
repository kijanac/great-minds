import type { Uuid } from "@great-minds/domain";

import { getVaultId } from "$lib/vault-selection";

export function selectedVault(vaultId?: Uuid): Uuid {
  const id = vaultId ?? getVaultId();
  if (id === null) throw new Error("No vault selected");
  return id;
}
