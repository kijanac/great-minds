<script lang="ts">
  import { page } from "$app/state";

  import HomeContainer from "$lib/components/home-container.svelte";

  const initialQuery = $derived(page.url.searchParams.get("q") ?? undefined);
  const origin = $derived(page.url.searchParams.get("origin") ?? undefined);
</script>

<svelte:head>
  <title>Great Minds</title>
</svelte:head>

<HomeContainer {initialQuery} {origin} />
