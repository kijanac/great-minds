<script lang="ts">
  import { onDestroy, tick } from "svelte";

  import { Button } from "$lib/components/ui/button";

  let { quote, context }: { quote: string; context: string | null } = $props();
  const id = $props.id();
  let expanded = $state(false);
  let transition: ViewTransition | undefined;
  const start = $derived(context?.indexOf(quote) ?? -1);
  const hasContext = $derived(start >= 0 && context !== quote);
  const words = $derived(quote.match(/\S+[^\S\r\n]*|\s+/g) ?? []);

  function toggle() {
    transition?.skipTransition();
    const next = !expanded;
    if (
      !document.startViewTransition ||
      !CSS.supports("view-transition-class", "passage-word") ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      expanded = next;
      return;
    }
    document.documentElement.dataset.passageMotion = next
      ? "expand"
      : "collapse";
    transition = document.startViewTransition(async () => {
      expanded = next;
      await tick();
    });
  }

  onDestroy(() => {
    transition?.skipTransition();
    delete document.documentElement.dataset.passageMotion;
  });
</script>

<section class="session-passage" aria-label="Original passage">
  <div class="passage-frame" aria-hidden="true"></div>
  <p
    class="passage-label font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted"
  >
    Where this started
  </p>
  <blockquote
    {id}
    class="mt-2 font-serif text-[length:var(--text-small)] leading-[1.9] text-warm-faint italic"
  >
    <span class="passage-word" style:view-transition-name="passage-open">“</span
    >{#if expanded && hasContext}<span>{context?.slice(0, start)}</span
      >{/if}<mark class="passage-quote"
      >{#each words as word, index}{#if /\S/.test(word)}<span
            class="passage-word"
            style:view-transition-name={`passage-word-${index}`}>{word}</span
          >{:else}{word}{/if}{/each}</mark
    >{#if expanded && hasContext}<span
        >{context?.slice(start + quote.length)}</span
      >{/if}<span
      class="passage-word"
      style:view-transition-name="passage-close">”</span
    >
  </blockquote>
  {#if hasContext}
    <Button
      variant="ghost"
      onclick={toggle}
      aria-expanded={expanded}
      aria-controls={id}
      class="passage-toggle mt-1 h-auto px-0 py-2 font-mono text-[length:var(--text-chrome)] text-gold hover:bg-transparent hover:text-warm"
    >
      {expanded ? "Show less" : "Show context"}
    </Button>
  {/if}
</section>

<style>
  .session-passage {
    position: relative;
    margin-top: 1rem;
    padding: 15px 18px;
    border: 1px solid transparent;
    border-radius: 3px;
    view-transition-name: session-passage;
  }
  .passage-frame {
    position: absolute;
    inset: -1px;
    border: 1px solid var(--ink-border);
    border-radius: inherit;
    pointer-events: none;
    view-transition-name: passage-frame;
  }
  blockquote {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .passage-label {
    view-transition-name: passage-label;
  }
  .passage-quote {
    background: transparent;
    color: var(--warm);
  }
  .passage-word {
    display: inline-block;
    padding: 2px 0;
    line-height: 1.2;
    white-space: pre;
    view-transition-class: passage-word;
  }
  .passage-quote .passage-word {
    background: color-mix(in srgb, var(--btw) 16%, var(--ink));
  }
  :global(.passage-toggle) {
    view-transition-name: passage-control;
  }
  :global(:root[data-passage-motion]) {
    view-transition-name: none;
    --passage-duration: 360ms;
    --passage-delay: 70ms;
    --passage-reveal: 180ms;
  }
  :global(:root[data-passage-motion="collapse"]) {
    --passage-duration: 240ms;
    --passage-delay: 0ms;
    --passage-reveal: 100ms;
  }
  :global(::view-transition) {
    pointer-events: none;
  }
  :global(::view-transition-group(*)) {
    animation-duration: var(--passage-duration, 360ms);
    animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1);
  }
  :global(::view-transition-old(session-passage)),
  :global(::view-transition-new(session-passage)) {
    height: 100%;
    object-fit: none;
    object-position: top left;
  }
  :global(::view-transition-old(session-passage)) {
    animation: passage-out 100ms ease-out both;
  }
  :global(::view-transition-new(session-passage)) {
    animation: passage-in var(--passage-reveal) ease-out var(--passage-delay)
      both;
  }
  :global(::view-transition-old(.passage-word)),
  :global(::view-transition-old(session-discussion)),
  :global(::view-transition-old(passage-control)),
  :global(::view-transition-old(passage-label)),
  :global(::view-transition-old(passage-frame)) {
    display: none;
  }
  :global(::view-transition-new(.passage-word)),
  :global(::view-transition-new(session-discussion)),
  :global(::view-transition-new(passage-control)),
  :global(::view-transition-new(passage-label)),
  :global(::view-transition-new(passage-frame)) {
    animation: none;
    mix-blend-mode: normal;
  }
  :global(::view-transition-new(passage-frame)) {
    height: 100%;
  }
  @keyframes -global-passage-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @keyframes -global-passage-out {
    from {
      opacity: 1;
    }
    to {
      opacity: 0;
    }
  }
</style>
