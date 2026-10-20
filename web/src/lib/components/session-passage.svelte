<script lang="ts">
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import { uniqueQuoteSpan } from "$lib/anchor";
  import { Button } from "$lib/components/ui/button";

  let {
    quote,
    context,
    href,
    sourceTitle,
  }: {
    quote: string;
    context: string | null;
    href: string | null;
    sourceTitle?: string;
  } = $props();

  const id = $props.id();
  let expanded = $state(false);
  const passage = $derived(expanded && context ? context : quote);
  const span = $derived(uniqueQuoteSpan(passage, quote));
</script>

<div class="mb-5">
  <blockquote
    {id}
    aria-label="Original passage"
    class="mb-2 whitespace-pre-wrap font-serif text-[length:var(--text-small)] leading-[1.85] text-warm-dim [overflow-wrap:anywhere]"
  >
    {#if span}{passage.slice(0, span.start)}{:else}<span class="mb-2 block"
        >{passage}</span
      >{/if}<mark class="bg-btw/22 text-inherit">{quote}</mark
    >{#if span}{passage.slice(span.end)}{/if}
  </blockquote>
  <div class="flex flex-wrap items-baseline gap-x-5 gap-y-1">
    {#if context && context !== quote}
      <Button
        variant="link"
        aria-expanded={expanded}
        aria-controls={id}
        onclick={() => (expanded = !expanded)}
        class="h-auto px-0 py-1 font-mono text-[length:var(--text-chrome)] text-warm-faint"
      >
        {expanded ? "Hide surrounding passage" : "Show surrounding passage"}
      </Button>
    {/if}
    {#if href}
      <a
        {href}
        title={sourceTitle}
        class="inline-flex items-center gap-2 py-1 font-mono text-[length:var(--text-chrome)] text-gold underline-offset-4 hover:underline"
      >
        <ArrowLeft size={12} /> Return to passage
      </a>
    {/if}
  </div>
</div>
