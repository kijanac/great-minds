<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import type { SelectionInfo } from "$lib/types";

  let {
    info,
    onFollowUp,
    onBtw,
    onSuggest,
  }: {
    info: SelectionInfo;
    onFollowUp?: () => void;
    onBtw: () => void;
    onSuggest?: () => void;
  } = $props();
</script>

<div
  data-popover
  class="fixed z-[300] -mt-1.5 flex -translate-x-1/2 -translate-y-full animate-[pop-in_0.14s_ease_forwards] overflow-hidden rounded-sm border border-gold-dim bg-popover shadow-[0_6px_24px_rgba(80,60,30,0.18)] dark:shadow-[0_6px_24px_rgba(0,0,0,0.7)]"
  style:left={`${info.x}px`}
  style:top={`${info.y}px`}
>
  {#if onFollowUp}
    <Button
      variant="ghost"
      size="sm"
      onmousedown={(event) => event.preventDefault()}
      onclick={onFollowUp}
      class="h-auto rounded-none px-3.5 py-[9px] font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-popover-foreground hover:bg-interactive-dim hover:text-gold"
    >
      + follow up
    </Button>
  {/if}
  <Button
    variant="ghost"
    size="sm"
    onmousedown={(event) => event.preventDefault()}
    onclick={onBtw}
    class={`h-auto rounded-none px-3.5 py-[9px] font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-btw hover:bg-btw-bg hover:text-btw-bright ${
      onFollowUp ? "border-l border-l-gold-dim" : ""
    }`}
  >
    btw
  </Button>
  {#if onSuggest}
    <Button
      variant="ghost"
      size="sm"
      onmousedown={(event) => event.preventDefault()}
      onclick={onSuggest}
      class="h-auto rounded-none border-l border-l-gold-dim px-3.5 py-[9px] font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:bg-interactive-dim hover:text-gold"
    >
      suggest
    </Button>
  {/if}
</div>
