<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";

  import ArticleBadge from "$lib/components/article-badge.svelte";
  import FilterBadge from "$lib/components/filter-badge.svelte";
  import SearchBadge from "$lib/components/search-badge.svelte";
  import { Button } from "$lib/components/ui/button";
  import type { SourceRef, ThinkingBlock } from "$lib/types";

  let {
    blocks,
    streaming,
    onCardClick,
    activeCard,
  }: {
    blocks: ThinkingBlock[];
    streaming: boolean;
    onCardClick: (source: SourceRef) => void;
    activeCard: string | null;
  } = $props();

  let userOverride = $state<boolean | null>(null);
  const open = $derived(userOverride ?? streaming);
  const allSources = $derived(blocks.flatMap((block) => block.sources));
  const summary = $derived.by(() => {
    const settled = allSources.filter((source) => source.pending !== true);
    const articles = settled.filter(
      (source) => source.type === "article",
    ).length;
    const raw = settled.filter((source) => source.type === "raw").length;
    const webSearches = settled.filter(
      (source) => source.type === "search" && source.scope === "web",
    ).length;
    const searches =
      settled.filter((source) => source.type === "search").length - webSearches;
    const filters = settled.filter((source) => source.type === "query").length;
    const links = settled.filter((source) => source.type === "links").length;
    const parts: string[] = [];

    if (searches) parts.push(`${searches} search${searches === 1 ? "" : "es"}`);
    if (webSearches)
      parts.push(`${webSearches} web search${webSearches === 1 ? "" : "es"}`);
    if (filters) parts.push(`${filters} filter${filters === 1 ? "" : "s"}`);
    if (articles)
      parts.push(`${articles} article${articles === 1 ? "" : "s"} read`);
    if (raw) parts.push(`${raw} source${raw === 1 ? "" : "s"} read`);
    if (links)
      parts.push(`${links} connection${links === 1 ? "" : "s"} explored`);
    return parts.join(", ") || "no sources";
  });
</script>

{#if blocks.length > 0 || streaming}
  <div class="mb-4">
    <Button
      variant="ghost"
      size="sm"
      onclick={() => (userOverride = !open)}
      class="h-auto gap-1.5 p-0 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:bg-transparent hover:text-gold"
    >
      {#if open}
        <ChevronDown size={10} />
      {:else}
        <ChevronRight size={10} />
      {/if}
      {#if streaming}
        <span class="animate-[pulse-fade_1.6s_ease-in-out_infinite]">
          traversing knowledge base...
        </span>
      {:else}
        <span>{summary}</span>
      {/if}
    </Button>

    {#if open}
      <div class="mt-2 space-y-3 border-l-2 border-interactive-ghost pl-3.5">
        <div class="relative z-[200] flex flex-wrap gap-[5px]">
          {#each allSources as source, index (`${source.type}:${index}:${source.label}`)}
            {#if source.type === "search"}
              <SearchBadge {source} />
            {:else if source.type === "query"}
              <FilterBadge
                summary={source.label}
                pending={source.pending === true}
              />
            {:else}
              <ArticleBadge
                {source}
                active={activeCard === source.label}
                onClick={source.pending ? undefined : () => onCardClick(source)}
              />
            {/if}
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}
