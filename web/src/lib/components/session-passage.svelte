<script lang="ts">
  import { uniqueQuoteSpan } from "$lib/anchor";

  let { quote, context }: { quote: string; context: string | null } = $props();
  const passage = $derived(context || quote);
  const span = $derived(uniqueQuoteSpan(passage, quote));
</script>

<blockquote
  aria-label="Original passage"
  class="mb-5 whitespace-pre-wrap font-serif text-[length:var(--text-body)] leading-[1.85] text-warm-dim [overflow-wrap:anywhere]"
>
  {#if span}{passage.slice(0, span.start)}{:else}<span class="mb-2 block"
      >{passage}</span
    >{/if}<mark class="bg-btw/22 text-inherit">{quote}</mark
  >{#if span}{passage.slice(span.end)}{/if}
</blockquote>
