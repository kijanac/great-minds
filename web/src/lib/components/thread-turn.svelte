<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    query,
    actions,
    children,
  }: {
    query: string;
    actions?: Snippet;
    children: Snippet;
  } = $props();
</script>

<div>
  <div
    class="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
  >
    <p
      class="min-w-0 whitespace-pre-wrap text-[length:var(--text-small)] leading-[1.72] text-warm-dim italic [overflow-wrap:anywhere]"
    >
      <span
        class="mr-1 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint not-italic"
        >you</span
      >
      {query}
    </p>
    {@render actions?.()}
  </div>
  {@render children()}
</div>
