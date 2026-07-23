<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ExternalLink from "@lucide/svelte/icons/external-link";

  import { articleMeta, type Article } from "$lib/api/doc";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { CHIP_BASE, CHIP_INACTIVE } from "$lib/chip";
  import { cn } from "$lib/utils";

  let {
    document,
    archived = false,
    supersededBy = null,
    onSupersessorClick,
  }: {
    document: Article;
    archived?: boolean;
    supersededBy?: string | null;
    onSupersessorClick?: (slug: string) => void;
  } = $props();

  let extraOpen = $state(false);
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

  <h1 class="mb-3 text-[length:var(--text-title)] font-bold text-foreground">
    {metadata.title}
  </h1>

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
