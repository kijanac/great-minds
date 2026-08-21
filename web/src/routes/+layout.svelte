<script lang="ts">
  import { dev } from "$app/environment";
  import { page } from "$app/state";
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import { SvelteQueryDevtools } from "@tanstack/svelte-query-devtools";
  import { onMount } from "svelte";

  import "../index.css";
  import { auth } from "$lib/auth.svelte";
  import AppShell from "$lib/components/app-shell.svelte";
  import CornerMenu from "$lib/components/corner-menu.svelte";
  import { TooltipProvider } from "$lib/components/ui/tooltip";
  import { activeVault } from "$lib/hooks/use-vault.svelte";
  import { queryClient } from "$lib/query-client";
  import { theme } from "$lib/theme.svelte";

  let { children } = $props();

  // Public share pages are chrome-less: no corner menu, even when signed in.
  const isShareRoute = $derived(
    page.route.id?.startsWith("/(public)/s/") ?? false,
  );

  onMount(() => {
    const stopAuth = auth.initialize();
    const stopTheme = theme.initialize();
    const stopVault = activeVault.initialize();
    return () => {
      stopAuth();
      stopTheme();
      stopVault();
    };
  });
</script>

{#snippet cornerMenu()}
  <CornerMenu />
{/snippet}

<QueryClientProvider client={queryClient}>
  <TooltipProvider>
    <AppShell utility={isShareRoute ? undefined : cornerMenu}>
      {@render children()}
    </AppShell>
  </TooltipProvider>
  {#if dev}
    <SvelteQueryDevtools initialIsOpen={false} />
  {/if}
</QueryClientProvider>
