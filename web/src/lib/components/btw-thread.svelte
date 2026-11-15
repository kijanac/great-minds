<script lang="ts">
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import CornerUpRight from "@lucide/svelte/icons/corner-up-right";
  import Square from "@lucide/svelte/icons/square";
  import { tick } from "svelte";

  import ArticleBadge from "#lib/components/article-badge.svelte";
  import FilterBadge from "#lib/components/filter-badge.svelte";
  import MarkdownView from "#lib/components/markdown-view.svelte";
  import ReplyInterrupted from "#lib/components/reply-interrupted.svelte";
  import ReplySubmissionError from "#lib/components/reply-submission-error.svelte";
  import SearchBadge from "#lib/components/search-badge.svelte";
  import ThreadSurface from "#lib/components/thread-surface.svelte";
  import ThreadTurn from "#lib/components/thread-turn.svelte";
  import * as Collapsible from "#lib/components/ui/collapsible/index.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Conversation } from "#lib/conversation.svelte.ts";
  import type { ThreadLike } from "#lib/types.ts";

  let {
    btw,
    onDismiss,
    readOnly = false,
    open = true,
    onOpenChange,
    hideWhenClosed = false,
  }: {
    btw: ThreadLike;
    onDismiss?: (btwId: string) => void;
    readOnly?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    hideWhenClosed?: boolean;
  } = $props();

  const live = $derived(btw instanceof Conversation && !readOnly ? btw : null);
  let input = $state("");
  let inputElement: HTMLTextAreaElement | null = $state(null);
  const isStreaming = $derived(live !== null && live.phase !== "idle" && live.phase !== "done");
  const stopLabel = $derived(
    live?.phase === "finalizing"
      ? "Saving response"
      : live?.stopping
        ? "Stopping response"
        : "Stop generating",
  );
  let focusedDraft = false;
  let wasStreaming = false;

  $effect(() => {
    const element = inputElement;
    const streaming = isStreaming;
    const newDraft = !focusedDraft && btw.exchanges.length === 0;
    const finished = wasStreaming && !streaming;
    wasStreaming = streaming;
    if (element && open && live && !streaming && (newDraft || finished)) {
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

  async function submit() {
    const text = input.trim();
    if (!text || !live?.canAsk) return;
    if ((await live.ask(text, true)) && input.trim() === text) input = "";
  }
</script>

{#if !hideWhenClosed || open}
  <Collapsible.Root
    id={btw.sessionId ? `thread-${btw.sessionId}` : undefined}
    data-btw-id={btw.id}
    {open}
    {onOpenChange}
    class="my-3"
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
            <span class="min-w-0 truncate text-[length:var(--text-caption)] text-warm-faint italic">
              “{btw.anchor.quote}”
            </span>
            <span class="shrink-0 text-gold-muted">
              {#if open}
                <ChevronDown size={12} />
              {:else}
                <ChevronRight size={12} />
              {/if}
            </span>
          </button>
        {/snippet}
      </Collapsible.Trigger>

      <Collapsible.Content>
        {#each btw.exchanges as exchange, index (exchange.id)}
          {@const sources = exchange.thinking.flatMap((block) => block.sources)}
          <div class="mt-4">
            <ThreadTurn query={exchange.query}>
              {#if sources.length > 0}
                <div class="mb-[9px] flex flex-wrap gap-[5px]">
                  {#each sources as source, index (`${source.type}:${index}:${source.label}`)}
                    {#if source.type === "search"}
                      <SearchBadge {source} />
                    {:else if source.type === "query"}
                      <FilterBadge summary={source.label} pending={source.pending === true} />
                    {:else}
                      <ArticleBadge {source} />
                    {/if}
                  {/each}
                </div>
              {/if}

              {#if exchange.status === "running" && !exchange.answer}
                <div
                  class="mb-[9px] animate-[pulse-fade_1.6s_ease-in-out_infinite] text-[length:var(--text-small)] leading-[1.72] text-warm-faint"
                >
                  {live?.phase === "finalizing"
                    ? "saving response…"
                    : sources.length > 0
                      ? "reading..."
                      : "thinking..."}
                </div>
              {:else}
                {#if exchange.answer}
                  <div class="mb-3 text-[length:var(--text-small)] leading-[1.85] text-warm-dim">
                    <MarkdownView source={exchange.answer} variant="btw" />
                    {#if exchange.status === "running" && live?.phase !== "finalizing"}
                      <span
                        class="ml-px inline-block h-2.5 w-px animate-[blink_1s_step-end_infinite] bg-gold-muted align-middle"
                      ></span>
                    {/if}
                  </div>
                {/if}

                {#if exchange.status === "stopped" || exchange.status === "failed"}
                  <ReplyInterrupted
                    stopped={exchange.status === "stopped"}
                    partial={exchange.answer.length > 0}
                    onRetry={exchange.status === "failed" &&
                    live?.phase === "done" &&
                    index === btw.exchanges.length - 1 &&
                    exchange.replyId
                      ? () => live.retry(exchange.id)
                      : undefined}
                  />
                {:else if exchange.status === "completed" && !exchange.answer}
                  <p class="text-[length:var(--text-small)] text-warm-faint">
                    The response completed without an answer.
                  </p>
                {/if}
              {/if}
            </ThreadTurn>
          </div>
        {/each}

        {#if live?.unavailable}
          <p role="status" class="mt-3 text-[length:var(--text-small)] text-warm-faint">
            {live.unavailable}
            <a class="text-gold underline underline-offset-4" href={`/sessions/${live.sessionId}`}
              >Try loading this note again</a
            >
          </p>
        {:else if live?.connectionError}
          <p role="status" class="mt-3 text-[length:var(--text-small)] text-warm-faint">
            {live.connectionError}
          </p>
          <Button
            variant="link"
            class="h-auto p-0 font-mono text-[length:var(--text-chrome)] text-gold"
            onclick={live.reconnect}>Reconnect</Button
          >
        {:else if live?.phase === "finalizing"}
          <p role="status" class="mt-3 font-mono text-[length:var(--text-chrome)] text-warm-faint">
            Saving response…
          </p>
        {/if}
        {#if live && !live.unavailable}
          <form
            class="mt-3"
            onsubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div class="flex items-end gap-3">
              <textarea
                bind:this={inputElement}
                bind:value={input}
                rows={2}
                aria-label={btw.exchanges.length === 0 ? "Ask a BTW" : "Reply to BTW"}
                disabled={isStreaming}
                class="max-h-52 min-h-12 w-full min-w-0 flex-1 resize-y border-0 border-b border-b-gold-dim bg-transparent py-1 font-serif text-[length:var(--text-small)] leading-[1.7] text-warm-dim italic caret-gold outline-none transition-colors placeholder:text-warm-faint focus:border-b-gold disabled:opacity-50"
                placeholder={btw.exchanges.length === 0 ? "Ask about this passage…" : "Reply…"}
                oninput={live.clearSubmissionFailure}
                onblur={(event) => {
                  if (
                    event.relatedTarget instanceof Node &&
                    event.currentTarget.form?.contains(event.relatedTarget)
                  )
                    return;
                  if (btw.draft && btw.exchanges.length === 0 && !input.trim() && onDismiss) {
                    onDismiss(btw.id);
                  }
                }}
                onkeydown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                    event.preventDefault();
                    void submit();
                  }
                }}></textarea>
              {#if isStreaming}
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={stopLabel}
                  title={stopLabel}
                  disabled={!live.canStop}
                  onclick={live.stop}
                  class="shrink-0 border-gold-dim text-gold hover:bg-transparent hover:text-warm"
                >
                  <Square size={12} fill="currentColor" />
                </Button>
              {:else}
                <Button
                  type="submit"
                  variant="outline"
                  size="icon"
                  aria-label="Send BTW"
                  disabled={!input.trim()}
                  class="shrink-0 border-gold-dim text-gold hover:bg-transparent hover:text-warm"
                >
                  <ArrowUp size={15} />
                </Button>
              {/if}
            </div>
            {#if live.submission.status === "failed"}
              <ReplySubmissionError class="mt-2" onRetry={() => void submit()} />
            {/if}
            {#if live.stopFailed}
              <p
                role="alert"
                class="mt-2 font-mono text-[length:var(--text-chrome)] text-destructive"
              >
                Couldn’t stop the response. Try again.
              </p>
            {/if}
            {#if live.sessionId && btw.exchanges.length > 0}
              <div class="mt-3 flex justify-start sm:justify-end">
                <a
                  href={`/sessions/${live.sessionId}`}
                  class="flex shrink-0 items-center gap-1 font-mono text-[length:var(--text-chrome)] text-gold transition-colors hover:text-foreground"
                >
                  Open full page
                  <CornerUpRight size={11} />
                </a>
              </div>
            {/if}
          </form>
        {/if}
      </Collapsible.Content>
    </ThreadSurface>
  </Collapsible.Root>
{/if}
