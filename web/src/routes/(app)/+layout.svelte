<script lang="ts">
  import { browser } from "$app/environment";
  import { goto } from "$app/navigation";

  import { auth } from "$lib/auth.svelte";

  let { children } = $props();

  $effect(() => {
    if (browser && auth.ready && !auth.isAuthenticated) {
      void goto("/login", { replaceState: true });
    }
  });
</script>

{#if auth.ready && auth.isAuthenticated}
  {@render children()}
{/if}
