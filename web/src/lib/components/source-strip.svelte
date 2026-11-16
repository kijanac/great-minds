<script lang="ts">
  import type { ReadStep } from "#lib/research-steps.ts";

  let {
    step,
    reading = false,
    width = 132,
    onPick,
  }: {
    step: ReadStep;
    reading?: boolean;
    width?: number;
    onPick?: (section: number) => void;
  } = $props();

  const chunks = $derived(step.source.chunks ?? 0);
  const cellCount = $derived(Math.min(chunks, Math.floor(width / 2)));
  const cells = $derived(
    Array.from({ length: cellCount }, (_, cell) => {
      const from = Math.floor((cell * chunks) / cellCount);
      const to = Math.max(from + 1, Math.floor(((cell + 1) * chunks) / cellCount));
      return Array.from({ length: to - from }, (_, offset) => from + offset);
    }),
  );
  const any = (sections: number[], set: ReadonlySet<number>) =>
    sections.some((section) => set.has(section));

  let seen: ReadonlySet<number> | null = null;
  let arrived = $state<ReadonlySet<number>>(new Set());
  $effect.pre(() => {
    const read = step.read;
    if (seen !== null) {
      const fresh = [...read].filter((section) => !seen?.has(section));
      if (fresh.length > 0) arrived = new Set(fresh);
    }
    seen = read;
  });
  const arrivedCells = $derived(
    cells.flatMap((sections, cell) => (any(sections, arrived) ? [cell] : [])),
  );
  const each = $derived(Math.min(90, 520 / Math.max(arrivedCells.length, 1)));
</script>

{#if step.pending}
  <span class="strip unknown" aria-hidden="true"></span>
{:else if cellCount > 0}
  <span
    class="strip"
    class:outline={step.source.outline === true}
    class:glow={reading && step.source.outline === true && arrivedCells.length === 0}
    class:pickable={onPick !== undefined}
    style:width={`${Math.min(width, Math.max(28, cellCount * (onPick ? 8 : 6)))}px`}
    style:--each={`${each}ms`}
    role={onPick ? "group" : undefined}
    aria-label={onPick ? "Sections" : undefined}
    aria-hidden={onPick ? undefined : "true"}
  >
    {#each cells as sections, cell (cell)}
      {@const fresh = arrivedCells.indexOf(cell)}
      <svelte:element
        this={onPick ? "button" : "i"}
        type={onPick ? "button" : undefined}
        role={onPick ? "button" : undefined}
        aria-label={onPick ? `§${sections[0]! + 1}` : undefined}
        onclick={onPick ? () => onPick(sections[0]!) : undefined}
        class:read={any(sections, step.read)}
        class:fetching={any(sections, step.fetching) && !any(sections, step.read)}
        class:cited={any(sections, step.cited)}
        class:glow={reading && fresh >= 0}
        style:--k={fresh >= 0 ? fresh : null}
      ></svelte:element>
    {/each}
  </span>
{/if}

<style>
  .strip {
    --strip-empty: color-mix(in oklab, var(--warm-ghost) 28%, transparent);
    display: inline-flex;
    flex: none;
    gap: 1px;
    height: 9px;
    vertical-align: middle;
  }
  .strip > * {
    flex: 1;
    min-width: 1px;
    border-radius: 0.5px;
    background: var(--strip-empty);
    transform-origin: bottom;
    transition:
      background-color 320ms cubic-bezier(0.25, 1, 0.5, 1),
      transform 220ms cubic-bezier(0.25, 1, 0.5, 1);
    transition-delay: calc(var(--k, 0) * var(--each, 0ms));
  }
  .strip > .read {
    background: color-mix(in oklab, var(--gold) 58%, var(--strip-empty));
  }
  .strip > .cited {
    background: var(--gold);
  }
  .strip > .fetching {
    animation: fetching 1s ease-in-out infinite;
  }
  .strip > .glow {
    animation: glow 1.5s ease-in-out infinite;
    animation-delay: calc(var(--k, 0) * 85ms);
  }
  .strip.pickable {
    height: 14px;
  }
  .strip.pickable > * {
    cursor: pointer;
  }
  .strip.pickable > *:hover {
    transform: scaleY(1.3);
  }
  .strip.outline {
    box-shadow: 0 -3px 0 -2px color-mix(in oklab, var(--gold-muted) 70%, transparent);
  }
  .strip.outline.glow {
    animation: glow-outline 1.5s ease-in-out infinite;
  }
  .strip.unknown {
    position: relative;
    width: 64px;
    overflow: hidden;
    border-radius: 1px;
    background: var(--strip-empty);
  }
  .strip.unknown::after {
    content: "";
    position: absolute;
    inset: 0;
    width: 45%;
    background: linear-gradient(
      90deg,
      transparent,
      color-mix(in oklab, var(--gold) 55%, transparent),
      transparent
    );
    animation: sweep 1.25s cubic-bezier(0.25, 1, 0.5, 1) infinite;
  }
  @keyframes fetching {
    0%,
    100% {
      background: color-mix(in oklab, var(--gold) 30%, var(--strip-empty));
    }
    50% {
      background: color-mix(in oklab, var(--gold) 70%, var(--strip-empty));
    }
  }
  @keyframes glow {
    0%,
    100% {
      background: color-mix(in oklab, var(--gold) 58%, var(--strip-empty));
    }
    35% {
      background: var(--gold);
      transform: scaleY(1.3);
    }
  }
  @keyframes glow-outline {
    50% {
      box-shadow: 0 -3px 0 -2px var(--gold);
    }
  }
  @keyframes sweep {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(230%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .strip > *,
    .strip > .glow,
    .strip > .fetching,
    .strip.outline.glow,
    .strip.unknown::after {
      animation: none;
      transition: none;
    }
  }
</style>
