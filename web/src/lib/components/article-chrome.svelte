<script lang="ts">
  import Home from "@lucide/svelte/icons/home";
  import type { Snippet } from "svelte";

  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";

  let {
    label,
    onHome,
    onQuery,
    children,
    footer,
  }: {
    label: string;
    onHome: () => void;
    onQuery: (question: string) => void;
    children: Snippet;
    footer?: Snippet;
  } = $props();

  let queryText = $state("");

  function submit() {
    const question = queryText.trim();
    if (!question) return;
    onQuery(question);
    queryText = "";
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") submit();
    if (event.key === "Escape") {
      queryText = "";
      (event.currentTarget as HTMLInputElement).blur();
    }
  }
</script>

<div class="flex h-screen flex-col overflow-hidden">
  <header
    class="flex shrink-0 items-center justify-between gap-3 border-b border-ink-subtle px-4 pt-4 pb-3 md:px-6"
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
        title={label}
        class="hidden min-w-0 max-w-[280px] truncate font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase md:inline"
      >
        {label}
      </span>
    </div>

    <div
      class="flex max-w-[400px] flex-1 items-center overflow-hidden rounded-sm border border-input bg-secondary focus-within:border-ring"
    >
      <Input
        bind:value={queryText}
        onkeydown={handleKeydown}
        class="h-auto flex-1 rounded-none border-none bg-transparent px-3 py-[9px] font-serif text-[length:var(--text-small)] text-foreground caret-gold placeholder:text-input focus-visible:border-none focus-visible:ring-0 dark:bg-transparent"
        placeholder="Ask about this article..."
        aria-label="ask about this article"
      />
      <Button
        onclick={submit}
        disabled={!queryText.trim()}
        class="h-auto rounded-none bg-gold px-3 py-[9px] font-mono text-[length:var(--text-chrome)] font-medium tracking-[0.12em] text-primary-foreground hover:bg-gold-hover disabled:bg-interactive-ghost disabled:text-muted-foreground disabled:opacity-100"
      >
        QUERY
      </Button>
    </div>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {@render children()}
  </div>

  {#if footer}
    {@render footer()}
  {/if}
</div>
