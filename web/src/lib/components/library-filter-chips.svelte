<script lang="ts">
  import X from "@lucide/svelte/icons/x";

  import { CHIP_ACTIVE, CHIP_BASE } from "$lib/chip";
  import * as ToggleGroup from "$lib/components/ui/toggle-group";
  import { FILTER_CHIP_CLASS } from "$lib/control-styles";
  import {
    LIBRARY_ALL,
    LIBRARY_ARTICLES,
    LIBRARY_READING_ROOM,
  } from "$lib/hooks/use-library.svelte";
  import type { SourceTypeFacet } from "$lib/types";
  import { cn } from "$lib/utils";

  let {
    activeType,
    activeTag,
    totalCount,
    articleTotal,
    sourceFacets,
    readingRoomTotal,
    onChange,
    onClearTag,
  }: {
    activeType: string;
    activeTag: string;
    totalCount: number;
    articleTotal: number;
    sourceFacets: SourceTypeFacet[];
    readingRoomTotal: number;
    onChange: (value: string) => void;
    onClearTag: () => void;
  } = $props();
</script>

<div class="mb-8 flex flex-wrap items-center gap-2">
  {#if activeTag}
    <button
      type="button"
      onclick={onClearTag}
      title={`clear tag filter`}
      class={cn(
        CHIP_BASE,
        CHIP_ACTIVE,
        "inline-flex items-center gap-1.5 hover:bg-gold/15",
      )}
    >
      <span class="lowercase">tag: {activeTag}</span>
      <X size={10} aria-hidden="true" />
    </button>
  {/if}
  <ToggleGroup.Root
    type="single"
    value={activeType}
    onValueChange={onChange}
    variant="outline"
    size="sm"
    class="flex-wrap"
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
</div>
