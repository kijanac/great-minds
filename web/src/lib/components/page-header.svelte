<script lang="ts">
  import Home from "@lucide/svelte/icons/home";
  import type { Snippet } from "svelte";

  import { Button } from "$lib/components/ui/button";

  let {
    title,
    detail,
    trailing,
    onHome,
  }: {
    title: string;
    detail?: Snippet;
    trailing?: Snippet;
    onHome: () => void;
  } = $props();
</script>

<header
  class={trailing
    ? "flex shrink-0 items-center justify-between gap-3 border-b border-ink-subtle px-4 pt-4 pb-3 md:px-6"
    : "flex shrink-0 items-center gap-4 border-b border-ink-subtle px-4 pt-4 pb-3 md:px-6"}
>
  <div class="flex shrink-0 items-center gap-4">
    <Button
      variant="ghost"
      size="icon-xs"
      onclick={onHome}
      aria-label="home"
      class="text-muted-foreground hover:bg-transparent hover:text-gold"
    >
      <Home size={14} />
    </Button>
    <span
      class="hidden font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase md:inline"
    >
      {title}
    </span>
    {@render detail?.()}
  </div>

  {@render trailing?.()}
</header>
