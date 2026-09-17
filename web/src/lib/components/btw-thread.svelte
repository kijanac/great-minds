<script lang="ts">
  import type { Uuid } from "@great-minds/domain";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import CornerUpRight from "@lucide/svelte/icons/corner-up-right";
  import { onMount, tick } from "svelte";

  import ArticleBadge from "$lib/components/article-badge.svelte";
  import FilterBadge from "$lib/components/filter-badge.svelte";
  import MarkdownView from "$lib/components/markdown-view.svelte";
  import ReplyInterrupted from "$lib/components/reply-interrupted.svelte";
  import SearchBadge from "$lib/components/search-badge.svelte";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { Button } from "$lib/components/ui/button";
  import type { ThreadLike } from "$lib/types";

  let {
    btw,
    onReply,
    onRetry,
    onDismiss,
    onOpenSession,
    readOnly = false,
    open = true,
    onOpenChange,
    hideWhenClosed = false,
  }: {
    btw: ThreadLike;
    onReply?: (btwId: string, text: string) => void;
    onRetry?: (btwId: string, turnId: Uuid) => void;
    onDismiss?: (btwId: string) => void;
    onOpenSession?: (btwId: string) => void;
    readOnly?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    hideWhenClosed?: boolean;
  } = $props();

  let input = $state("");
  let inputElement: HTMLInputElement | null = $state(null);
  const shortAnchor = $derived(
    btw.anchor.quote.length > 58
      ? `${btw.anchor.quote.slice(0, 58)}...`
      : btw.anchor.quote,
  );
  const isStreaming = $derived(
    btw.exchanges.some((exchange) => exchange.streaming),
  );
  const canOpenSession = $derived(
    !readOnly && !!btw.conversation && btw.exchanges.length > 0,
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
    onReply?.(btw.id, text);
    input = "";
  }
</script>

{#if !hideWhenClosed || open}
  {#if btw.conversation?.kind === "session"}
    <div
      id={`thread-${btw.conversation.id}`}
      class="my-3 border-y border-ink-border py-3"
    >
      <p
        class="mb-1 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost"
      >
        Continued as a session
      </p>
      <Button
        variant="ghost"
        onclick={() => onOpenSession?.(btw.id)}
        class="h-auto justify-start gap-2 whitespace-normal p-0 text-left font-serif text-[length:var(--text-small)] text-gold hover:bg-transparent hover:text-warm"
      >
        {btw.conversation.query}
        <CornerUpRight size={13} class="shrink-0" />
      </Button>
    </div>
  {:else}
    <Collapsible.Root
      id={btw.conversation ? `thread-${btw.conversation.id}` : undefined}
      {open}
      {onOpenChange}
      class="my-[10px] mb-3 rounded-sm border border-ink-border bg-ink-raised/70 px-4 py-3"
    >
      <Collapsible.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="flex h-auto w-full items-baseline justify-start gap-2 rounded-none p-0 text-left hover:bg-transparent"
          >
            <span
              class="shrink-0 font-mono text-[length:var(--text-chrome)] tracking-[0.16em] text-gold uppercase"
            >
              btw
            </span>
            <span
              class="min-w-0 flex-1 truncate text-[length:var(--text-caption)] text-muted-foreground italic"
            >
              ❝ {shortAnchor} ❞
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
          </button>
        {/snippet}
      </Collapsible.Trigger>

      <Collapsible.Content>
        {#each btw.exchanges as exchange, index (exchange.id)}
          {@const sources = exchange.thinking.flatMap((block) => block.sources)}
          <div>
            <div
              class="mb-[9px] mt-1 text-[length:var(--text-small)] leading-[1.72] text-warm-ghost italic"
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
              {#if exchange.answer}
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

              {#if exchange.error || !exchange.answer}
                <ReplyInterrupted
                  partial={exchange.answer.length > 0}
                  onRetry={!readOnly &&
                  index === btw.exchanges.length - 1 &&
                  (exchange.replyId || exchange.error) &&
                  onRetry
                    ? () => onRetry(btw.id, exchange.id)
                    : undefined}
                />
              {/if}
            {/if}
          </div>
        {/each}

        {#if btw.error}
          <p
            role="status"
            class="mt-3 font-mono text-[length:var(--text-chrome)] text-warm-faint"
          >
            {btw.error}
          </p>
        {/if}
        {#if !readOnly && !isStreaming}
          <div
            class="mt-[5px] flex items-center gap-3"
            role="presentation"
            onmousedown={(event) => event.stopPropagation()}
          >
            <input
              bind:this={inputElement}
              bind:value={input}
              aria-label={btw.exchanges.length === 0
                ? "Ask a BTW"
                : "Reply to BTW"}
              disabled={btw.promoting}
              class="w-full min-w-0 flex-1 border-0 border-b border-b-gold-dim bg-transparent py-[3px] font-serif text-[length:var(--text-caption)] text-warm-ghost italic caret-gold outline-none transition-colors placeholder:text-interactive-dim focus:border-b-gold"
              placeholder="reply…"
              onblur={() => {
                if (btw.exchanges.length === 0 && !input.trim() && onDismiss) {
                  onDismiss(btw.id);
                }
              }}
              onkeydown={(event) => {
                if (event.key === "Enter") submit();
              }}
            />
            {#if canOpenSession}
              <Button
                variant="ghost"
                disabled={btw.promoting}
                onclick={() => onOpenSession?.(btw.id)}
                class="flex h-auto shrink-0 items-center gap-1 whitespace-normal p-0 font-mono text-[length:var(--text-chrome)] text-gold transition-colors hover:bg-transparent hover:text-foreground"
              >
                {btw.promoting ? "Continuing…" : "Continue as a session"}
                <CornerUpRight size={11} />
              </Button>
            {/if}
          </div>
        {/if}
      </Collapsible.Content>
    </Collapsible.Root>
  {/if}
{/if}
