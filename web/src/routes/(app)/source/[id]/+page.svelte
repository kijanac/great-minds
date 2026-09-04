<script lang="ts">
  import { page } from "$app/state";
  import { Uuid } from "@great-minds/domain";
  import { Option, Schema } from "effect";

  import ArticleReader from "$lib/components/article-reader.svelte";

  const decodeSourceId = Schema.decodeOption(Uuid);
  const sourceId = $derived(
    page.params.id === undefined
      ? null
      : Option.getOrNull(decodeSourceId(page.params.id)),
  );
</script>

<svelte:head>
  <title>Source | Great Minds</title>
</svelte:head>

{#if sourceId}
  <ArticleReader {sourceId} scope="vault" />
{/if}
