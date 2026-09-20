<script lang="ts">
  import type { Uuid } from "@great-minds/domain";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import CornerUpRight from "@lucide/svelte/icons/corner-up-right";
  import { tick } from "svelte";

  import ArticleBadge from "$lib/components/article-badge.svelte";
  import FilterBadge from "$lib/components/filter-badge.svelte";
  import MarkdownView from "$lib/components/markdown-view.svelte";
  import ReplyInterrupted from "$lib/components/reply-interrupted.svelte";
  import SearchBadge from "$lib/components/search-badge.svelte";
  import ThreadSurface from "$lib/components/thread-surface.svelte";
  import ThreadTurn from "$lib/components/thread-turn.svelte";
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
  let inputElement: HTMLTextAreaElement | null = $state(null);
  const shortAnchor = $derived(
    btw.anchor.quote.length > 58
      ? `${btw.anchor.quote.slice(0, 58)}...`
      : btw.anchor.quote,
  );
  const isStreaming = $derived(
    btw.exchanges.some((exchange) => exchange.streaming),
  );
  let focusedDraft = false;
  let wasStreaming = false;

  $effect(() => {
    const element = inputElement;
    const streaming = isStreaming;
    const newDraft = !focusedDraft && btw.exchanges.length === 0;
    const finished = wasStreaming && !streaming;
    wasStreaming = streaming;
    if (element && open && !readOnly && !streaming && (newDraft || finished)) {
      if (newDraft) focusedDraft = true;
      void tick().then(() => {
        if (!element.isConnected || element.disabled) return;
        const active = document.activeElement;
        if (newDraft || active === null || active === document.body) {
          element.focus({ preventScroll: true });
          element.scrollIntoView({ block: "nearest" });
        }
      });
    }
  });

  function submit() {
    const text = input.trim();
    if (!text || isStreaming || btw.promoting) return;
    onReply?.(btw.id, text);
    input = "";
  }
</script>

{#if !hideWhenClosed || open}
  {#if btw.conversation?.kind === "session"}
    <div
      id={`thread-${btw.conversation.id}`}
      data-btw-id={btw.id}
      class="my-3 border-y border-ink-border py-3"
    >
      <p
        class="mb-1 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost"
      >
        Continued as a session
      </p>
      <a
        href={`/sessions/${btw.conversation.id}`}
        class="inline-flex items-center gap-2 text-left font-serif text-[length:var(--text-small)] text-gold hover:text-warm"
      >
        {btw.conversation.query}
        <CornerUpRight size={13} class="shrink-0" />
      </a>
    </div>
  {:else}
    <Collapsible.Root
      id={btw.conversation ? `thread-${btw.conversation.id}` : undefined}
      data-btw-id={btw.id}
      {open}
      {onOpenChange}
      class="my-[10px] mb-3"
    >
      <ThreadSurface>
        <Collapsible.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="flex h-auto w-full items-baseline justify-start gap-2 rounded-none p-0 text-left hover:bg-transparent"
            >
              <span
                class="shrink-0 font-mono text-[length:var(--text-chrome)] tracking-[0.16em] text-btw uppercase"
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
            {@const sources = exchange.thinking.flatMap(
              (block) => block.sources,
            )}
            <div class="mt-4">
              <ThreadTurn query={exchange.query}>
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
              </ThreadTurn>
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
          {#if !readOnly}
            <form
              class="mt-3"
              onsubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <div class="flex items-end gap-3">
                <textarea
                  bind:this={inputElement}
                  bind:value={input}
                  rows={2}
                  aria-label={btw.exchanges.length === 0
                    ? "Ask a BTW"
                    : "Reply to BTW"}
                  disabled={btw.promoting || isStreaming}
                  class="max-h-52 min-h-12 w-full min-w-0 flex-1 resize-y border-0 border-b border-b-gold-dim bg-transparent py-1 font-serif text-[length:var(--text-small)] leading-[1.7] text-warm-dim italic caret-gold outline-none transition-colors placeholder:text-warm-faint focus:border-b-gold disabled:opacity-50"
                  placeholder={btw.exchanges.length === 0
                    ? "Ask about this passage…"
                    : "Reply…"}
                  onblur={(event) => {
                    if (
                      event.relatedTarget instanceof Node &&
                      event.currentTarget.form?.contains(event.relatedTarget)
                    )
                      return;
                    if (
                      btw.exchanges.length === 0 &&
                      !input.trim() &&
                      onDismiss
                    ) {
                      onDismiss(btw.id);
                    }
                  }}
                  onkeydown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.isComposing
                    ) {
                      event.preventDefault();
                      submit();
                    }
                  }}></textarea>
                <Button
                  type="submit"
                  variant="outline"
                  size="icon"
                  aria-label="Send BTW"
                  disabled={btw.promoting || isStreaming || !input.trim()}
                  class="shrink-0 border-gold-dim text-gold hover:bg-transparent hover:text-warm"
                >
                  <ArrowUp size={15} />
                </Button>
              </div>
              {#if btw.conversation && btw.exchanges.length > 0}
                <div class="mt-3 flex justify-start sm:justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={btw.promoting || isStreaming}
                    onclick={() => onOpenSession?.(btw.id)}
                    class="flex h-auto shrink-0 items-center gap-1 whitespace-normal p-0 font-mono text-[length:var(--text-chrome)] text-gold transition-colors hover:bg-transparent hover:text-foreground"
                  >
                    {btw.promoting ? "Continuing…" : "Continue as a session"}
                    <CornerUpRight size={11} />
                  </Button>
                </div>
              {/if}
            </form>
          {/if}
        </Collapsible.Content>
      </ThreadSurface>
    </Collapsible.Root>
  {/if}
{/if}
