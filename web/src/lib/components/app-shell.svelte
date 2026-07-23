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

<div
  class="relative h-screen"
  style:--shell-utility-inset={utility ? "3.5rem" : "2.5rem"}
>
  {@render children()}
  {#if utility}
    <div class="fixed bottom-4 left-4 z-[100]">
      {@render utility()}
    </div>
  {/if}
</div>
