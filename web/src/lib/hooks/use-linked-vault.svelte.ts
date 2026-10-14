import { Uuid } from "@great-minds/domain";
import { Option, Schema } from "effect";

import { errorMessage } from "$lib/api/errors";
import { activeVault, switchVault, useVaults } from "$lib/hooks/use-vault.svelte";

const decodeVaultId = Schema.decodeUnknownOption(Uuid);

export function useLinkedVault(parameter: () => string | null) {
  const vaults = useVaults();
  const requested = $derived(parameter());
  const parsed = $derived(requested === null ? Option.none<Uuid>() : decodeVaultId(requested));
  const id = $derived(Option.getOrNull(parsed));
  const error = $derived(
    requested === null
      ? null
      : id === null
        ? "This document link has an invalid vault."
        : vaults.error
          ? errorMessage(vaults.error, "Couldn’t load your vaults.")
          : vaults.isSuccess && !vaults.data.some((vault) => vault.id === id)
            ? "You don’t have access to this document’s vault."
            : null,
  );
  $effect(() => {
    if (id !== null && vaults.isSuccess && error === null && activeVault.id !== id) switchVault(id);
  });
  return {
    get id() {
      return id ?? activeVault.id;
    },
    get error() {
      return error;
    },
    get pending() {
      return requested !== null && error === null && (!vaults.isSuccess || activeVault.id !== id);
    },
  };
}
