<script lang="ts">
  let {
    error = null,
    partial = false,
  }: {
    error?: string | null;
    partial?: boolean;
  } = $props();
</script>

<div
  role="status"
  class="mb-3 rounded-sm border border-gold-dim/70 bg-gold/5 px-3 py-2 font-mono text-[length:var(--text-chrome)] leading-relaxed tracking-[0.06em] text-gold-muted"
>
  <span class="font-semibold text-gold">reply interrupted</span>
  {#if partial}
    — partial answer below may be incomplete
  {:else if !error}
    — ask again below
  {/if}
  {#if error}
    <span class="text-warm-faint"> — {error}</span>
  {/if}
</div>
