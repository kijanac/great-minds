<script lang="ts">
  import type { SessionOrigin } from "@great-minds/domain";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  import { uniqueQuoteSpan } from "#lib/anchor.ts";
  import * as Collapsible from "#lib/components/ui/collapsible/index.ts";
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

  let open = $state(false);
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

{#snippet quote(text: string)}
  <q
    class="font-serif text-[length:var(--text-small)] text-warm-dim italic [overflow-wrap:anywhere]"
    >{text}</q
  >
{/snippet}

<Collapsible.Root bind:open>
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
      {#if origin.anchor && context}
        <Collapsible.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              title={open ? "Hide the surrounding passage" : "Show the surrounding passage"}
              class="group inline-flex cursor-pointer items-baseline gap-1.5 text-left"
            >
              {@render quote(origin.anchor ?? "")}
              <span class="self-center text-gold-muted group-hover:text-gold">
                <ChevronDown
                  size={12}
                  class={[
                    "transition-transform duration-200 motion-reduce:transition-none",
                    open && "rotate-180",
                  ]}
                />
              </span>
            </button>
          {/snippet}
        </Collapsible.Trigger>
      {:else if origin.anchor}
        {@render quote(origin.anchor)}
      {:else}
        <span>the whole document</span>
      {/if}
    </div>
    {#if context}
      <Collapsible.Content>
        <blockquote
          class="mt-2.5 border-l border-ink-border pl-3.5 font-serif text-[length:var(--text-small)] leading-[1.85] whitespace-pre-wrap text-warm-dim [overflow-wrap:anywhere]"
        >
          {#if span}{context.slice(0, span.start)}<mark class="bg-btw/22 text-inherit"
              >{origin.anchor}</mark
            >{context.slice(span.end)}{:else}{context}{/if}
        </blockquote>
      </Collapsible.Content>
    {/if}
  </nav>
</Collapsible.Root>
