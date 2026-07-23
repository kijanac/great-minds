<script lang="ts">
  import Globe from "@lucide/svelte/icons/globe";
  import Search from "@lucide/svelte/icons/search";

  import { Badge } from "$lib/components/ui/badge";
  import type { SourceRef } from "$lib/types";
  import { displayTitle } from "$lib/utils";

  let { source }: { source: SourceRef } = $props();
  const web = $derived(source.scope === "web");
  const documentTitle = $derived(
    source.path ? displayTitle(source.path, source.title) : null,
  );
</script>

<Badge
  variant="outline"
  title={web ? "web search" : "knowledge base search"}
  class={`h-auto cursor-default rounded-sm border-ink-border bg-ink-raised px-[9px] py-[3px] font-mono text-[length:var(--text-chrome)] tracking-[0.06em] whitespace-nowrap text-warm-ghost italic ${
    source.pending ? "animate-[pulse-fade_1.6s_ease-in-out_infinite]" : ""
  }`}
>
  {#if web}
    <Globe size={9} class="mr-1.5 text-gold-muted" />
  {:else}
    <Search size={9} class="mr-1.5 opacity-60" />
  {/if}
  {source.label}
  {#if documentTitle}
    <span class="opacity-60"> · in {documentTitle}</span>
  {/if}
</Badge>
