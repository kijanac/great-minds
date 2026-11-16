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

  let content: HTMLElement | undefined;
  let lefts = new Map<Element, number>();
  $effect.pre(() => {
    void open;
    lefts = new Map(
      Array.from(content?.querySelectorAll("[data-lean]") ?? [], (element) => [
        element,
        element.getBoundingClientRect().left,
      ]),
    );
  });
  $effect(() => {
    void open;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const [element, left] of lefts) {
      for (const animation of element.getAnimations()) animation.cancel();
      const shift = left - element.getBoundingClientRect().left;
      if (Math.abs(shift) < 1) continue;
      element.animate([{ transform: `translateX(${shift}px)` }, { transform: "none" }], {
        duration: 280,
        easing: "cubic-bezier(0.33, 1, 0.68, 1)",
      });
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="relative flex h-dvh overflow-hidden [--panel:clamp(440px,38vw,640px)]">
  <div bind:this={content} data-panel-open={open || undefined} class="min-w-0 flex-1">
    {@render children()}
  </div>

  <div aria-hidden="true" class={["shrink-0", open && panel && "min-[1200px]:w-(--panel)"]}></div>
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
      class="fixed inset-y-0 right-0 z-[200] h-dvh w-full border-l border-ink-subtle bg-ink-panel shadow-none md:w-(--panel) md:shadow-[-24px_0_60px_rgba(80,60,30,0.12)] min-[1200px]:z-auto dark:md:shadow-[-24px_0_60px_rgba(0,0,0,0.6)]"
      in:fly={{ x: 16, duration: 280, easing: cubicOut }}
      out:fly={{ x: 16, duration: 180, easing: cubicOut }}
    >
      {@render panel()}
    </aside>
  {/if}
</div>
