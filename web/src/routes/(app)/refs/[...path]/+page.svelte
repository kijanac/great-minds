<script lang="ts">
  import { page } from "$app/state";

  import ArticleReader from "$lib/components/article-reader.svelte";

  const path = $derived(page.params.path);
</script>

<svelte:head>
  <title>Reference | Great Minds</title>
</svelte:head>

{#if path}
  <ArticleReader {path} scope="personal" />
{/if}
