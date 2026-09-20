<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import type { SelectionInfo } from "$lib/types";

  let {
    info,
    onFollowUp,
    onBtw,
    onSuggest,
    onDismiss,
  }: {
    info: SelectionInfo;
    onFollowUp?: () => void;
    onBtw: () => void;
    onSuggest?: () => void;
    onDismiss: () => void;
  } = $props();

  let root: HTMLDivElement | null = $state(null);
  let width = $state(0);
  let height = $state(0);
  const top = $derived(
    info.rect.top - height - 12 >= 8
      ? info.rect.top - height - 12
      : info.rect.bottom + 12,
  );
  let returnFocus: HTMLElement | null = null;
  let entered = false;

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (root?.contains(document.activeElement))
        returnFocus?.focus({ preventScroll: true });
      onDismiss();
    } else if (
      event.key === "Tab" &&
      !event.shiftKey &&
      !entered &&
      !root?.contains(document.activeElement)
    ) {
      event.preventDefault();
      entered = true;
      returnFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      root?.querySelector("button")?.focus({ preventScroll: true });
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  bind:this={root}
  bind:offsetWidth={width}
  bind:offsetHeight={height}
  data-popover
  role="group"
  aria-label="Actions for selected passage"
  class="fixed z-[300] flex w-max max-w-[calc(100vw-1rem)] animate-[pop-in_0.14s_ease_forwards] flex-wrap overflow-hidden rounded-sm border border-gold-dim bg-popover shadow-[0_6px_24px_rgba(80,60,30,0.18)] motion-reduce:animate-none dark:shadow-[0_6px_24px_rgba(0,0,0,0.7)]"
  style:left={`clamp(8px, ${info.rect.left + (info.rect.width - width) / 2}px, calc(100vw - ${width + 8}px))`}
  style:top={`clamp(8px, ${top}px, calc(100dvh - ${height + 8}px))`}
>
  {#if onFollowUp}
    <Button
      variant="ghost"
      size="sm"
      onmousedown={(event) => event.preventDefault()}
      onclick={onFollowUp}
      class="h-auto max-w-full rounded-none px-3.5 py-[9px] font-mono text-[length:var(--text-chrome)] tracking-[0.1em] whitespace-normal text-popover-foreground [overflow-wrap:anywhere] hover:bg-interactive-dim hover:text-gold"
    >
      + follow up
    </Button>
  {/if}
  <Button
    variant="ghost"
    size="sm"
    onmousedown={(event) => event.preventDefault()}
    onclick={onBtw}
    class={`h-auto max-w-full rounded-none px-3.5 py-[9px] font-mono text-[length:var(--text-chrome)] tracking-[0.1em] whitespace-normal text-btw [overflow-wrap:anywhere] hover:bg-btw-bg hover:text-btw-bright ${
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
      class="h-auto max-w-full rounded-none border-l border-l-gold-dim px-3.5 py-[9px] font-mono text-[length:var(--text-chrome)] tracking-[0.1em] whitespace-normal text-gold-muted [overflow-wrap:anywhere] hover:bg-interactive-dim hover:text-gold"
    >
      suggest
    </Button>
  {/if}
</div>
