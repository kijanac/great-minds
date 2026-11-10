<script lang="ts">
  import MarkdownView from "#lib/components/markdown-view.svelte";
  import type { ExportMessage } from "#lib/hooks/use-session-export.svelte.ts";

  let {
    entry,
    index,
    disabled,
    onSelect,
  }: {
    entry: ExportMessage;
    index: number;
    disabled: boolean;
    onSelect: (selected: boolean) => void;
  } = $props();

  const id = $props.id();
  let expanded = $state(false);
  let truncated = $state(false);

  function measure(node: HTMLElement) {
    const observer = new ResizeObserver(() => {
      truncated = node.scrollHeight > parseFloat(getComputedStyle(node).lineHeight) * 3 + 1;
    });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
</script>

<div
  class="message grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 py-3"
  class:excluded={!entry.selected}
>
  <div class="flex h-11 items-center">
    <input
      {id}
      type="checkbox"
      checked={entry.selected}
      {disabled}
      onchange={(event) => onSelect(event.currentTarget.checked)}
      aria-label={`Include ${entry.message.role === "user" ? "your message" : "agent reply"} ${index + 1}`}
      class="size-4 cursor-pointer accent-gold disabled:cursor-wait"
    />
  </div>
  <div class="min-w-0">
    <label
      for={id}
      class="flex min-h-11 w-fit cursor-pointer items-center font-mono text-xs text-warm-faint"
      >{entry.message.role === "user" ? "You" : "Agent"}</label
    >
    <div
      id={`${id}-text`}
      class="excerpt text-[length:var(--text-body)] leading-[1.65] [overflow-wrap:anywhere]"
      class:collapsed={!expanded}
    >
      <div use:measure>
        {#if entry.message.role === "assistant" && entry.text}
          <MarkdownView source={entry.text} variant="btw" />
        {:else}
          <p class="whitespace-pre-wrap">{entry.text || "No saved text"}</p>
        {/if}
      </div>
    </div>
    {#if truncated}
      <button
        type="button"
        onclick={() => (expanded = !expanded)}
        aria-expanded={expanded}
        aria-controls={`${id}-text`}
        class="mt-1 min-h-11 cursor-pointer rounded-sm font-mono text-xs text-warm-faint underline-offset-4 hover:text-gold hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold"
        >{expanded ? "Show less" : "Show more"}</button
      >
    {/if}
  </div>
</div>

<style>
  .message {
    transition: color 140ms ease-out;
  }
  .excluded {
    color: var(--color-warm-faint);
  }
  .collapsed {
    max-height: 3lh;
    overflow: hidden;
  }
  .excerpt :global(p:first-child),
  .excerpt :global(h1:first-child),
  .excerpt :global(h2:first-child),
  .excerpt :global(h3:first-child) {
    margin-top: 0;
  }
  .excerpt :global(p:last-child),
  .excerpt :global(ul:last-child),
  .excerpt :global(ol:last-child) {
    margin-bottom: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .message {
      transition: none;
    }
  }
</style>
