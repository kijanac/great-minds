<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import type { Snippet } from "svelte";
  import { fade, fly } from "svelte/transition";

  let {
    open,
    onClose,
    children,
    panel,
  }: {
    open: boolean;
    onClose: () => void;
    children: Snippet;
    panel?: Snippet;
  } = $props();

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="relative flex h-screen overflow-hidden">
  <div class="min-w-0 flex-1">
    {@render children()}
  </div>

  {#if open && panel}
    <button
      type="button"
      aria-label="close article panel"
      class="fixed inset-0 z-[180] bg-black/20 min-[1200px]:hidden"
      onclick={onClose}
      transition:fade={{ duration: 160 }}
    ></button>
    <aside
      aria-label="article preview"
      class="fixed inset-y-0 right-0 z-[200] h-screen w-full border-l border-ink-subtle bg-ink-panel shadow-none md:w-[370px] md:shadow-[-24px_0_60px_rgba(80,60,30,0.12)] min-[1200px]:relative min-[1200px]:inset-auto min-[1200px]:z-auto min-[1200px]:shrink-0 dark:md:shadow-[-24px_0_60px_rgba(0,0,0,0.6)]"
      in:fly={{ x: 16, duration: 280, easing: cubicOut }}
      out:fly={{ x: 16, duration: 180, easing: cubicOut }}
    >
      {@render panel()}
    </aside>
  {/if}
</div>
