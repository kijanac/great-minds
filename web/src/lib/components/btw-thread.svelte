<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { onMount, tick } from "svelte";

  import ArticleBadge from "$lib/components/article-badge.svelte";
  import FilterBadge from "$lib/components/filter-badge.svelte";
  import MarkdownView from "$lib/components/markdown-view.svelte";
  import SearchBadge from "$lib/components/search-badge.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import type { BtwThread } from "$lib/types";

  let {
    btw,
    onReply,
    onDismiss,
    onSpinOff,
  }: {
    btw: BtwThread;
    onReply: (btwId: string, text: string) => void;
    onDismiss?: (btwId: string) => void;
    onSpinOff?: (btwId: string) => void;
  } = $props();

  let input = $state("");
  let open = $state(true);
  let inputElement: HTMLInputElement | null = $state(null);
  const shortAnchor = $derived(
    btw.anchor.quote.length > 58
      ? `${btw.anchor.quote.slice(0, 58)}...`
      : btw.anchor.quote,
  );
  const isStreaming = $derived(
    btw.exchanges.some((exchange) => exchange.streaming),
  );
  let mounted = false;
  let wasStreaming = false;

  onMount(() => {
    mounted = true;
    if (btw.exchanges.length === 0) {
      inputElement?.focus({ preventScroll: true });
    }
  });

  $effect(() => {
    const streaming = isStreaming;
    if (mounted && wasStreaming && !streaming) {
      void tick().then(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) {
          inputElement?.focus({ preventScroll: true });
        }
      });
    }
    wasStreaming = streaming;
  });

  function submit() {
    const text = input.trim();
    if (!text) return;
    onReply(btw.id, text);
    input = "";
  }
</script>

<Collapsible.Root
  bind:open
  class="my-[10px] mb-3 border-l-2 border-gold-dim pl-3.5"
>
  <Collapsible.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        class="flex h-auto w-full items-baseline justify-start gap-2 rounded-none p-0 pb-[7px] text-left hover:bg-transparent"
      >
        <span
          class="shrink-0 font-mono text-[length:var(--text-chrome)] tracking-[0.16em] text-gold uppercase"
        >
          BTW
        </span>
        <span
          class="flex-1 text-left text-[length:var(--text-caption)] text-muted-foreground italic"
        >
          “{shortAnchor}”
        </span>
        <span
          class="shrink-0 font-mono text-[length:var(--text-chrome)] text-interactive-dim"
        >
          {#if open}
            <ChevronDown size={10} />
          {:else}
            <ChevronRight size={10} />
          {/if}
        </span>
      </Button>
    {/snippet}
  </Collapsible.Trigger>

  <Collapsible.Content>
    {#each btw.exchanges as exchange (exchange.id)}
      {@const sources = exchange.thinking.flatMap((block) => block.sources)}
      <div>
        <div
          class="mb-[9px] text-[length:var(--text-small)] leading-[1.72] text-warm-ghost italic"
        >
          <span
            class="mr-0.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-interactive-dim not-italic"
          >
            you ·
          </span>
          {exchange.query}
        </div>

        {#if sources.length > 0}
          <div class="mb-[9px] flex flex-wrap gap-[5px]">
            {#each sources as source, index (`${source.type}:${index}:${source.label}`)}
              {#if source.type === "search"}
                <SearchBadge {source} />
              {:else if source.type === "query"}
                <FilterBadge
                  summary={source.label}
                  pending={source.pending === true}
                />
              {:else}
                <ArticleBadge {source} />
              {/if}
            {/each}
          </div>
        {/if}

        {#if exchange.streaming && !exchange.answer}
          <div
            class="mb-[9px] animate-[pulse-fade_1.6s_ease-in-out_infinite] text-[length:var(--text-small)] leading-[1.72] text-warm-faint"
          >
            {sources.length > 0 ? "reading..." : "thinking..."}
          </div>
        {:else}
          <div
            class="mb-[9px] text-[length:var(--text-small)] leading-[1.72] text-warm-faint"
          >
            <MarkdownView source={exchange.answer} variant="btw" />
            {#if exchange.streaming}
              <span
                class="ml-px inline-block h-2.5 w-px animate-[blink_1s_step-end_infinite] bg-gold-muted align-middle"
              ></span>
            {/if}
          </div>
        {/if}
      </div>
    {/each}

    {#if onSpinOff && btw.exchanges.length > 0 && !isStreaming}
      <div
        class="mb-[6px] text-[length:var(--text-chrome)] tracking-[0.06em] text-interactive-dim italic"
      >
        ephemeral ·
        <button
          type="button"
          onclick={() => onSpinOff?.(btw.id)}
          class="font-mono tracking-[0.1em] text-gold uppercase not-italic transition-colors hover:text-foreground"
        >
          save as session
        </button>
      </div>
    {/if}

    {#if !isStreaming}
      <div
        class="mt-[5px]"
        role="presentation"
        onmousedown={(event) => event.stopPropagation()}
      >
        <input
          bind:this={inputElement}
          bind:value={input}
          class="w-full border-0 border-b border-b-gold-dim bg-transparent py-[3px] font-serif text-[length:var(--text-caption)] text-warm-ghost italic caret-gold outline-none transition-colors placeholder:text-interactive-dim focus:border-b-gold"
          placeholder="continue..."
          onblur={() => {
            if (btw.exchanges.length === 0 && !input.trim() && onDismiss) {
              onDismiss(btw.id);
            }
          }}
          onkeydown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
      </div>
    {/if}
  </Collapsible.Content>
</Collapsible.Root>
