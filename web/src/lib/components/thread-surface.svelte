<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<div class="rounded-sm border border-ink-border bg-ink-raised p-4">
  {@render children()}
</div>
