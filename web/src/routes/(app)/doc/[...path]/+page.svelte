<script lang="ts">
  import { page } from "$app/state";

  import ArticleReader from "$lib/components/article-reader.svelte";

  const path = $derived(page.params.path);
</script>

<svelte:head>
  <title>Document | Great Minds</title>
</svelte:head>

{#if path}
  <ArticleReader {path} />
{/if}
