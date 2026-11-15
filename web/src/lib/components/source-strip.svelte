<script lang="ts">
  import type { ReadStep } from "#lib/research-steps.ts";

  let {
    step,
    reading = false,
    width = 132,
  }: {
    step: ReadStep;
    reading?: boolean;
    width?: number;
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
    style:width={`${Math.min(width, Math.max(28, cellCount * 6))}px`}
    style:--each={`${each}ms`}
    aria-hidden="true"
  >
    {#each cells as sections, cell (cell)}
      {@const fresh = arrivedCells.indexOf(cell)}
      <i
        class:read={any(sections, step.read)}
        class:fetching={any(sections, step.fetching) && !any(sections, step.read)}
        class:cited={any(sections, step.cited)}
        class:hit={any(sections, step.hits)}
        class:glow={reading && fresh >= 0}
        style:--k={fresh >= 0 ? fresh : null}
      ></i>
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
  .strip i {
    position: relative;
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
  .strip i.read {
    background: color-mix(in oklab, var(--gold) 58%, var(--strip-empty));
  }
  .strip i.cited {
    background: var(--gold);
  }
  .strip i.fetching {
    animation: fetching 1s ease-in-out infinite;
  }
  .strip i.hit::after {
    content: "";
    position: absolute;
    top: -5px;
    left: 50%;
    width: 3px;
    height: 3px;
    margin-left: -1.5px;
    border-radius: 50%;
    background: var(--gold-muted);
  }
  .strip i.glow {
    animation: glow 1.5s ease-in-out infinite;
    animation-delay: calc(var(--k, 0) * 85ms);
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
    .strip i,
    .strip i.glow,
    .strip i.fetching,
    .strip.outline.glow,
    .strip.unknown::after {
      animation: none;
      transition: none;
    }
  }
</style>
