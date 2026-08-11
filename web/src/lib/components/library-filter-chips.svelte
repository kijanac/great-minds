<script lang="ts">
  import * as ToggleGroup from "$lib/components/ui/toggle-group";
  import { FILTER_CHIP_CLASS } from "$lib/control-styles";
  import {
    LIBRARY_ALL,
    LIBRARY_ARTICLES,
    LIBRARY_READING_ROOM,
  } from "$lib/hooks/use-library.svelte";
  import type { SourceTypeFacet } from "$lib/types";

  let {
    activeType,
    totalCount,
    articleTotal,
    sourceFacets,
    readingRoomTotal,
    onChange,
  }: {
    activeType: string;
    totalCount: number;
    articleTotal: number;
    sourceFacets: SourceTypeFacet[];
    readingRoomTotal: number;
    onChange: (value: string) => void;
  } = $props();
</script>

<ToggleGroup.Root
  type="single"
  value={activeType}
  onValueChange={onChange}
  variant="outline"
  size="sm"
  class="mb-8 flex-wrap"
>
  <ToggleGroup.Item value={LIBRARY_ALL} class={FILTER_CHIP_CLASS}>
    all · {totalCount}
  </ToggleGroup.Item>
  <ToggleGroup.Item value={LIBRARY_ARTICLES} class={FILTER_CHIP_CLASS}>
    articles · {articleTotal}
  </ToggleGroup.Item>
  {#each sourceFacets as facet (facet.value)}
    <ToggleGroup.Item value={facet.value} class={FILTER_CHIP_CLASS}>
      {facet.value} · {facet.count}
    </ToggleGroup.Item>
  {/each}
  <ToggleGroup.Item value={LIBRARY_READING_ROOM} class={FILTER_CHIP_CLASS}>
    reading room · {readingRoomTotal}
  </ToggleGroup.Item>
</ToggleGroup.Root>
