<script lang="ts">
  import { page } from "$app/state";

  import ArticleReader from "$lib/components/article-reader.svelte";

  const sourceId = $derived(page.params.id ?? null);
</script>

<svelte:head>
  <title>Source | Great Minds</title>
</svelte:head>

{#if sourceId}
  <ArticleReader {sourceId} scope="vault" />
{/if}
