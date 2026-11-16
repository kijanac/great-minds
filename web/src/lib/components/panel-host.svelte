<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import type { Snippet } from "svelte";
  import { fade } from "svelte/transition";

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

  const enter = { duration: 280, easing: cubicOut };
  const leave = { duration: 180, easing: cubicOut };

  let content: HTMLElement | undefined;
  const glides = new Map<HTMLElement, Animation>();
  let spans = new Map<HTMLElement, number>();
  const dock = (docked: boolean) => content?.toggleAttribute("data-panel-open", docked);
  const stop = () => {
    for (const glide of glides.values()) glide.cancel();
    glides.clear();
  };
  const settle = () => {
    stop();
    dock(true);
  };

  const slide = (_: Element) => () => {
    const seen = Array.from(
      content?.querySelectorAll<HTMLElement>("[data-lean]") ?? [],
      (column) => [column, column.getBoundingClientRect().left] as const,
    );
    stop();
    dock(true);
    const docked = seen.map(
      ([column, left]) => [column, left, column.getBoundingClientRect().left] as const,
    );
    dock(false);
    spans = new Map();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return { duration: 0 };
    for (const [column, left, target] of docked) {
      const layout = column.getBoundingClientRect().left;
      if (Math.abs(target - layout) < 0.5) continue;
      spans.set(column, target - layout);
      const hold = { transform: `translateX(${left - layout}px)` };
      glides.set(column, column.animate([hold, hold], { fill: "forwards" }));
    }
    return {
      ...(open ? enter : leave),
      css: (t: number) => `transform: translateX(${(1 - t) * 100}%)`,
    };
  };

  const mirror = ({ currentTarget }: Event) =>
    queueMicrotask(() => {
      const panel =
        currentTarget instanceof HTMLElement ? currentTarget.getAnimations().at(-1) : undefined;
      const effect = panel?.effect;
      stop();
      if (panel === undefined || !(effect instanceof KeyframeEffect)) return;
      const shown = effect
        .getKeyframes()
        .map(
          (frame) =>
            1 - Number.parseFloat(String(frame.transform).slice("translateX(".length)) / 100,
        );
      panel.startTime = document.timeline.currentTime;
      for (const [column, span] of spans) {
        const glide = column.animate(
          shown.map((t) => ({ transform: `translateX(${span * t}px)` })),
          effect.getTiming(),
        );
        glide.startTime = panel.startTime;
        glides.set(column, glide);
      }
    });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="relative flex h-dvh overflow-hidden [--panel:clamp(440px,38vw,640px)]">
  <div bind:this={content} class="min-w-0 flex-1">
    {@render children()}
  </div>

  <div data-panel-spacer aria-hidden="true" class="shrink-0"></div>
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
      transition:slide
      onintrostart={mirror}
      onoutrostart={mirror}
      onintroend={settle}
      onoutroend={stop}
    >
      {@render panel()}
    </aside>
  {/if}
</div>
