<script lang="ts">
  import X from "@lucide/svelte/icons/x";

  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";

  let {
    chips,
    disabled = false,
    onRemoveChip,
    onSubmit,
  }: {
    chips: string[];
    disabled?: boolean;
    onRemoveChip: (index: number) => void;
    onSubmit: (text: string) => void;
  } = $props();

  let input = $state("");
  const canSubmit = $derived(!disabled && (chips.length > 0 || !!input.trim()));

  function submit() {
    if (!canSubmit) return;
    onSubmit(input.trim());
    input = "";
  }
</script>

<div
  class="shrink-0 animate-[slide-up_0.28s_cubic-bezier(0.4,0,0.2,1)] border-t border-ink-subtle pt-3 pr-4 pb-3.5 pl-[var(--shell-utility-inset)] md:pr-10"
>
  <div class="mx-auto flex w-full max-w-[740px] flex-col gap-2">
    {#if chips.length > 0}
      <div class="flex flex-wrap gap-[5px]">
        {#each chips as chip, index (index)}
          <Badge
            variant="outline"
            class="flex h-auto max-w-[280px] items-center gap-[7px] rounded-sm border-gold-dim bg-interactive-dim py-1 pr-[9px] pl-[11px] text-[length:var(--text-caption)] text-warm-ghost italic"
          >
            <span
              class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
            >
              “{chip.length > 42 ? `${chip.slice(0, 42)}...` : chip}”
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onclick={() => onRemoveChip(index)}
              aria-label="remove selection"
              class="h-auto w-auto p-0 text-[length:var(--text-small)] text-gold-dim hover:bg-transparent hover:text-gold-muted"
            >
              <X size={12} />
            </Button>
          </Badge>
        {/each}
      </div>
    {/if}

    <div class="flex items-center">
      <Input
        bind:value={input}
        {disabled}
        class="h-auto flex-1 rounded-none border-0 border-b border-b-gold-dim bg-transparent px-0 py-[3px] font-serif text-[length:var(--text-small)] text-warm-dim caret-gold transition-colors placeholder:text-interactive-dim focus-visible:border-b-gold focus-visible:ring-0 dark:bg-transparent"
        placeholder={chips.length > 0
          ? "add context or submit selections..."
          : "follow up..."}
        onkeydown={(event) => {
          if (event.key === "Enter") submit();
        }}
      />
      <Button
        variant="outline"
        size="sm"
        onclick={submit}
        disabled={!canSubmit}
        class="ml-3.5 h-auto rounded-sm border-ink-border px-[13px] py-[7px] font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-muted-foreground hover:border-gold-dim hover:text-gold disabled:opacity-25"
      >
        FOLLOW UP
      </Button>
    </div>
  </div>
</div>
