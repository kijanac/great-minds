<script lang="ts">
  let {
    partial = false,
    onRetry,
  }: {
    partial?: boolean;
    onRetry?: () => void;
  } = $props();
</script>

<div
  role="status"
  class="mt-3 mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[length:var(--text-chrome)] leading-relaxed tracking-[0.04em] text-warm-faint"
>
  <span>
    {partial
      ? "Answer interrupted. This response may be incomplete."
      : "Couldn’t generate an answer."}
  </span>
  {#if onRetry}
    <button
      type="button"
      onclick={onRetry}
      class="shrink-0 text-gold underline decoration-gold-dim underline-offset-4 transition-colors hover:text-foreground focus-visible:rounded-xs focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-gold"
    >
      Try again
    </button>
  {/if}
</div>
