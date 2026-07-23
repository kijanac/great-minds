<script lang="ts">
  import Waypoints from "@lucide/svelte/icons/waypoints";

  import { Badge } from "$lib/components/ui/badge";
  import type { SourceRef } from "$lib/types";
  import { displayTitle } from "$lib/utils";

  let {
    source,
    active = false,
    onClick,
  }: {
    source: SourceRef;
    active?: boolean;
    onClick?: () => void;
  } = $props();

  function handleKeydown(event: KeyboardEvent) {
    if (!onClick || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onClick();
  }
</script>

<Badge
  variant="outline"
  onclick={onClick}
  onkeydown={handleKeydown}
  title={source.thinking}
  role={onClick ? "button" : undefined}
  tabindex={onClick ? 0 : undefined}
  class={`h-auto rounded-sm px-[9px] py-[3px] font-mono text-[length:var(--text-chrome)] tracking-[0.06em] whitespace-nowrap transition-all ${
    onClick ? "cursor-pointer" : "cursor-default"
  } ${
    active
      ? "border-gold-dim bg-interactive-dim text-gold"
      : "border-ink-border bg-ink-raised text-card-foreground hover:border-gold-dim hover:text-gold"
  } ${source.pending ? "animate-[pulse-fade_1.6s_ease-in-out_infinite]" : ""}`}
>
  {#if source.type === "links"}
    <Waypoints size={9} class="mr-1.5 opacity-60" />
  {/if}
  {displayTitle(source.label, source.title)}
</Badge>
