<script lang="ts">
  import type { SessionOrigin } from "@great-minds/domain";

  import { uniqueQuoteSpan } from "#lib/anchor.ts";
  import { docDisplayName } from "#lib/utils.ts";

  let {
    origin,
    title,
    href,
  }: {
    origin: SessionOrigin;
    title: string | null;
    href: string | null;
  } = $props();

  const id = $props.id();
  let expanded = $state(false);
  const name = $derived(
    title ??
      (origin.kind === "answer" ? "an earlier conversation" : docDisplayName(origin.doc_path)),
  );
  const context = $derived(
    origin.anchor && origin.paragraph && origin.paragraph !== origin.anchor
      ? origin.paragraph
      : null,
  );
  const span = $derived(context && origin.anchor ? uniqueQuoteSpan(context, origin.anchor) : null);
</script>

<nav
  aria-label="What this conversation is about"
  class="mb-4 font-mono text-[length:var(--text-chrome)] leading-[1.8] text-warm-faint"
>
  <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
    <span>about</span>
    {#if href}
      <a
        {href}
        title={origin.anchor ? "Return to passage" : undefined}
        class="text-gold-muted underline decoration-ink-border underline-offset-[3px] [overflow-wrap:anywhere] hover:text-gold"
        >{name}</a
      >
    {:else}
      <span class="[overflow-wrap:anywhere]">{name}</span>
    {/if}
    <span aria-hidden="true" class="text-ink-border">›</span>
    {#if origin.anchor}
      <q
        class="font-serif text-[length:var(--text-small)] text-warm-dim italic [overflow-wrap:anywhere]"
        >{origin.anchor}</q
      >
    {:else}
      <span>the whole document</span>
    {/if}
    {#if context}
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        onclick={() => (expanded = !expanded)}
        class="text-warm-ghost underline decoration-ink-border underline-offset-[3px] hover:text-warm-dim"
        >{expanded ? "hide passage" : "show passage"}</button
      >
    {/if}
  </div>
  {#if context && expanded}
    <blockquote
      {id}
      class="mt-2.5 border-l border-ink-border pl-3.5 font-serif text-[length:var(--text-small)] leading-[1.85] whitespace-pre-wrap text-warm-dim [overflow-wrap:anywhere]"
    >
      {#if span}{context.slice(0, span.start)}<mark class="bg-btw/22 text-inherit"
          >{origin.anchor}</mark
        >{context.slice(span.end)}{:else}{context}{/if}
    </blockquote>
  {/if}
</nav>
