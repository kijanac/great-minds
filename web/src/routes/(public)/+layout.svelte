<script lang="ts">
  import { browser } from "$app/env";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  import { auth } from "#lib/auth.svelte.ts";

  let { children } = $props();

  const isShareRoute = $derived(page.route.id?.startsWith("/(public)/s/") ?? false);

  $effect(() => {
    if (browser && auth.ready && auth.isAuthenticated && !isShareRoute) {
      void goto("/", { replace: true });
    }
  });
</script>

{#if auth.ready && (!auth.isAuthenticated || isShareRoute)}
  {@render children()}
{/if}
