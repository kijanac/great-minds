<script lang="ts">
  import { browser } from "$app/environment";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  import { auth } from "$lib/auth.svelte";
  import { activeVault, useVaults } from "$lib/hooks/use-vault.svelte";
  import { clearVaultId, storeVaultId } from "$lib/vault-selection";

  let { children } = $props();

  const vaults = useVaults();

  $effect(() => {
    if (browser && auth.ready && !auth.isAuthenticated) {
      const next = `${page.url.pathname}${page.url.search}`;
      void goto(
        next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`,
        {
          replaceState: true,
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
