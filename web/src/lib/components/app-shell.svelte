<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    children,
    utility,
  }: {
    children: Snippet;
    utility?: Snippet;
  } = $props();
</script>

<div class="relative h-dvh" style:--shell-utility-inset={utility ? "3.5rem" : "2.5rem"}>
  {@render children()}
  {#if utility}
    <div
      class="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-4 z-[100] rounded-sm bg-background/90 backdrop-blur-sm"
    >
      {@render utility()}
    </div>
  {/if}
</div>
