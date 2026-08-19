<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import CornerUpRight from "@lucide/svelte/icons/corner-up-right";
  import ExternalLink from "@lucide/svelte/icons/external-link";

  import { articleMeta, type Article, type DocumentScope } from "$lib/api/doc";
  import ReferencePromoteAction from "$lib/components/reference-promote-action.svelte";
  import ShareDialog from "$lib/components/share-dialog.svelte";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { CHIP_BASE, CHIP_INACTIVE } from "$lib/chip";
  import type { ThreadLike } from "$lib/types";
  import { cn, formatShortDate } from "$lib/utils";
  import type { ReferencePromotionAction as PromotionAction } from "$lib/types";

  let {
    document,
    scope,
    promotionAction = null,
    archived = false,
    supersededBy = null,
    onSupersessorClick,
    threads = [],
    onThreadJump,
    onThreadOpen,
  }: {
    document: Article;
    scope: DocumentScope;
    promotionAction?: PromotionAction | null;
    archived?: boolean;
    supersededBy?: string | null;
    onSupersessorClick?: (slug: string) => void;
    threads?: ThreadLike[];
    onThreadJump?: (threadId: string) => void;
    onThreadOpen?: (threadId: string) => void;
  } = $props();

  let extraOpen = $state(false);
  let threadsOpen = $state(false);
  const isAnchored = (thread: ThreadLike): boolean =>
    (thread as { anchored?: boolean }).anchored ?? true;
  const notes = $derived(threads.filter(isAnchored));
  const conversations = $derived(
    threads.filter((thread) => !isAnchored(thread)),
  );
  const showThreadsChip = $derived(notes.length + conversations.length > 0);
  const shortQuote = (quote: string) =>
    quote.length > 44 ? `${quote.slice(0, 44)}...` : quote;
  const metadata = $derived(articleMeta(document));
  const metaParts = $derived(
    [metadata.author, metadata.published_date, metadata.genre].filter(
      (part): part is string => !!part,
    ),
  );
  const extraEntries = $derived(
    Object.entries(metadata.derived_extras ?? {}).filter(
      ([key]) => key !== "topic_id",
    ),
  );

  function formatValue(value: unknown): string {
    if (value === null || value === undefined) return "—";
    if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }
</script>

<header class="mb-10">
  {#if archived}
    <div class="mb-6 rounded-sm border border-gold-dim bg-ink-raised px-4 py-3">
      <p
        class="mb-1 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted uppercase"
      >
        archived article
      </p>
      <p class="font-serif text-[length:var(--text-body)] text-warm-dim">
        {#if supersededBy}
          This concept has been retired. See
          <button
            type="button"
            onclick={() => onSupersessorClick?.(supersededBy)}
            class="text-gold underline underline-offset-2 hover:text-gold-bright"
          >
            {supersededBy}
          </button>
          for the current version.
        {:else}
          This concept has been retired. No successor has been identified.
        {/if}
      </p>
    </div>
  {/if}

  <div class="mb-3 flex items-start justify-between gap-5">
    <h1
      class="min-w-0 text-[length:var(--text-title)] font-bold text-foreground"
    >
      {metadata.title}
    </h1>
    {#if scope === "personal"}
      <div class="flex shrink-0 items-start gap-2">
        {#if promotionAction}
          <ReferencePromoteAction action={promotionAction} />
        {/if}
        {#if document.kind === "reference"}
          <ShareDialog subjectKind="reference" subjectId={document.id} />
        {/if}
      </div>
    {/if}
  </div>

  {#if metadata.precis}
    <p
      class="mb-4 font-serif text-[length:var(--text-body)] leading-[1.6] text-warm-dim italic"
    >
      {metadata.precis}
    </p>
  {/if}

  {#if metaParts.length > 0}
    <p
      class="mb-3 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint"
    >
      {metaParts.join(" · ")}
    </p>
  {/if}

  {#if metadata.tags.length > 0}
    <div class="mb-3 flex flex-wrap gap-2">
      {#each metadata.tags as tag (tag)}
        <span class={cn(CHIP_BASE, CHIP_INACTIVE)}>{tag}</span>
      {/each}
    </div>
  {/if}

  {#if metadata.url || metadata.origin}
    <p
      class="mb-3 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
    >
      {#if metadata.url}
        <a
          href={metadata.url}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1 text-gold-muted underline decoration-gold/30 underline-offset-2 hover:text-gold"
        >
          from {metadata.origin || metadata.url}
          <ExternalLink size={11} />
        </a>
      {:else}
        from {metadata.origin}
      {/if}
    </p>
  {/if}

  {#if showThreadsChip}
    <Collapsible.Root bind:open={threadsOpen} class="mt-4">
      <Collapsible.Trigger
        class="flex h-auto items-center gap-2 rounded-sm border border-ink-border bg-ink-raised px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-faint transition-colors hover:border-gold-dim hover:text-warm"
      >
        <span class="text-gold-muted">⊹</span>
        <span>
          {notes.length} note{notes.length === 1 ? "" : "s"} ·
          {conversations.length} conversation{conversations.length === 1
            ? ""
            : "s"}
        </span>
        {#if threadsOpen}
          <ChevronDown size={11} />
        {:else}
          <ChevronRight size={11} />
        {/if}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div class="mt-3 space-y-2.5 border-l border-ink-subtle pl-4">
          {#if notes.length > 0}
            <p
              class="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted uppercase"
            >
              notes
            </p>
            {#each notes as note (note.id)}
              <button
                type="button"
                onclick={() => onThreadJump?.(note.id)}
                class="group flex w-full items-baseline gap-2 text-left"
              >
                <span class="shrink-0 text-[10px] leading-none text-btw">●</span
                >
                <span
                  class="min-w-0 flex-1 truncate font-serif text-[length:var(--text-small)] text-warm-dim italic transition-colors group-hover:text-warm"
                >
                  “{shortQuote(note.anchor.quote)}”
                </span>
                <span
                  class="shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost lowercase"
                >
                  {note.exchanges.length} turn{note.exchanges.length === 1
                    ? ""
                    : "s"} ·
                  {formatShortDate(note.createdAt ?? null)}
                </span>
                <span
                  class="shrink-0 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted uppercase transition-colors group-hover:text-gold"
                >
                  jump
                </span>
              </button>
            {/each}
          {/if}
          {#if conversations.length > 0}
            <p
              class="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted uppercase"
            >
              conversations
            </p>
            {#each conversations as conversation (conversation.id)}
              <button
                type="button"
                onclick={() => onThreadOpen?.(conversation.id)}
                class="group flex w-full items-baseline gap-2 text-left"
              >
                <CornerUpRight
                  size={11}
                  class="shrink-0 translate-y-px text-gold-muted"
                />
                <span
                  class="min-w-0 flex-1 truncate font-serif text-[length:var(--text-small)] text-warm-dim italic transition-colors group-hover:text-warm"
                >
                  “{shortQuote(
                    conversation.exchanges[0]?.query ?? "untitled conversation",
                  )}”
                </span>
                <span
                  class="shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost lowercase"
                >
                  {formatShortDate(conversation.createdAt ?? null)}
                </span>
                <span
                  class="shrink-0 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted uppercase transition-colors group-hover:text-gold"
                >
                  open
                </span>
              </button>
            {/each}
          {/if}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  {/if}

  {#if extraEntries.length > 0}
    <Collapsible.Root bind:open={extraOpen} class="mt-4">
      <Collapsible.Trigger
        class="flex h-auto items-center gap-2 rounded-none p-0 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost uppercase hover:bg-transparent hover:text-warm-faint"
      >
        {#if extraOpen}
          <ChevronDown size={11} />
        {:else}
          <ChevronRight size={11} />
        {/if}
        more metadata
      </Collapsible.Trigger>
      <Collapsible.Content>
        <dl
          class="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
        >
          {#each extraEntries as [name, value] (name)}
            <dt class="tracking-[0.08em] text-gold-muted">{name}</dt>
            <dd class="break-words text-warm-faint">{formatValue(value)}</dd>
          {/each}
        </dl>
      </Collapsible.Content>
    </Collapsible.Root>
  {/if}
</header>
