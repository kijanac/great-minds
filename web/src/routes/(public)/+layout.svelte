<script lang="ts">
  import { browser } from "$app/environment";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  import { auth } from "$lib/auth.svelte";

  let { children } = $props();

  const isShareRoute = $derived(
    page.route.id?.startsWith("/(public)/s/") ?? false,
  );

  $effect(() => {
    if (browser && auth.ready && auth.isAuthenticated && !isShareRoute) {
      void goto("/", { replaceState: true });
    }
  });
</script>

{#if auth.ready && (!auth.isAuthenticated || isShareRoute)}
  {@render children()}
{/if}
