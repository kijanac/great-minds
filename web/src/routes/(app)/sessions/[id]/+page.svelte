<script lang="ts">
  import { page } from "$app/state";

  import HomeContainer from "$lib/components/home-container.svelte";

  const sessionId = $derived(page.params.id);
</script>

<svelte:head>
  <title>Session | Great Minds</title>
</svelte:head>

{#if sessionId}
  <HomeContainer {sessionId} />
{/if}
