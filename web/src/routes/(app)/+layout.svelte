<script lang="ts">
  import { browser } from "$app/env";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  import { auth } from "#lib/auth.svelte.ts";
  import { activeVault, useVaults } from "#lib/hooks/use-vault.svelte.ts";
  import { clearVaultId, storeVaultId } from "#lib/vault-selection.ts";

  let { children } = $props();

  const vaults = useVaults();

  $effect(() => {
    if (browser && auth.ready && !auth.isAuthenticated) {
      const next = `${page.url.pathname}${page.url.search}`;
      void goto(
        next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`,
        {
          replace: true,
        },
      );
    }
  });

  $effect(() => {
    if (!auth.isAuthenticated || !vaults.isSuccess) return;
    if (vaults.data.some((vault) => vault.id === activeVault.id)) return;
    const first = vaults.data[0];
    if (first) storeVaultId(first.id);
    else if (activeVault.id !== null) clearVaultId();
  });
</script>

{#if auth.ready && auth.isAuthenticated}
  {@render children()}
{/if}
