<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<div class="rounded-sm border border-ink-border bg-ink-raised/70 px-4 py-3">
  {@render children()}
</div>
