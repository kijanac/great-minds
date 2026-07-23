<script lang="ts">
  import { dev } from "$app/environment";
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import { SvelteQueryDevtools } from "@tanstack/svelte-query-devtools";
  import { onMount } from "svelte";

  import "../index.css";
  import { auth } from "$lib/auth.svelte";
  import { queryClient } from "$lib/query-client";
  import { theme } from "$lib/theme.svelte";

  let { children } = $props();

  onMount(() => {
    const stopAuth = auth.initialize();
    const stopTheme = theme.initialize();
    return () => {
      stopAuth();
      stopTheme();
    };
  });
</script>

<QueryClientProvider client={queryClient}>
  {@render children()}
  {#if dev}
    <SvelteQueryDevtools initialIsOpen={false} />
  {/if}
</QueryClientProvider>
