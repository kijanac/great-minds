<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.ts";
  import { useMe } from "#lib/hooks/use-me.svelte.ts";
  import { Skeleton } from "#lib/components/ui/skeleton/index.ts";
  import type { WikiArticleOverview } from "#lib/types.ts";
  import { formatShortDate } from "#lib/utils.ts";

  let {
    articles,
    startHere,
    loading,
    error,
    lastUpdated,
    sourceTotal,
    updatedSinceVisit,
    canUpdate,
    updating,
    updateError,
    onOpen,
    onSources,
    onReadingRoom,
    onUpdate,
  }: {
    articles: readonly WikiArticleOverview[];
    startHere: readonly WikiArticleOverview[];
    loading: boolean;
    error: string | null;
    lastUpdated: Date | null;
    sourceTotal: number;
    updatedSinceVisit: boolean;
    canUpdate: boolean;
    updating: boolean;
    updateError: string | null;
    onOpen: (article: WikiArticleOverview) => void;
    onSources: () => void;
    onReadingRoom: () => void;
    onUpdate: () => void;
  } = $props();

  const me = useMe();

  const jump = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  const sortKey = (title: string) =>
    title.replace(/^(the|a|an)\s+/i, "").toLocaleLowerCase();
  const letterOf = (title: string) => {
    const first = sortKey(title).charAt(0).toLocaleUpperCase();
    return /\p{L}/u.test(first) ? first : "#";
  };
  const letters = $derived.by(() => {
    const groups = new Map<string, WikiArticleOverview[]>();
    for (const article of articles.toSorted((left, right) =>
      sortKey(left.title).localeCompare(sortKey(right.title)),
    )) {
      const letter = letterOf(article.title);
      groups.set(letter, [...(groups.get(letter) ?? []), article]);
    }
    return [...groups].toSorted(([left], [right]) =>
      left === "#" ? 1 : right === "#" ? -1 : left.localeCompare(right),
    );
  });
</script>

<div id="contents-top" class="scroll-mt-4">
  {#if updatedSinceVisit}
    <p
      class="mb-6 border-l-2 border-gold-dim py-1 pl-3 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint"
    >
      The library was updated since your last visit.
    </p>
  {/if}

  <div class="mb-2 flex items-center justify-between gap-4">
    <h1 class="font-serif text-[length:var(--text-title)] text-warm">
      Contents
    </h1>
    {#if canUpdate}
      <Button
        variant="outline"
        size="sm"
        onclick={onUpdate}
        disabled={updating || !me.canUseModels}
        class="min-h-9 rounded-sm disabled:opacity-45 border-gold-dim font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold uppercase hover:bg-gold/10"
      >
        {updating ? "starting…" : "update"}
      </Button>
    {/if}
  </div>
  {#if updateError}
    <p class="mb-2 font-mono text-[length:var(--text-chrome)] text-destructive">
      {updateError}
    </p>
  {/if}
  <p
    class="mb-9 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
  >
    {#if lastUpdated}Last updated {formatShortDate(lastUpdated)} ·
    {/if}<button
      type="button"
      onclick={onSources}
      class="text-warm-faint underline decoration-ink-border underline-offset-[3px] hover:text-warm-dim"
      >{sourceTotal.toLocaleString("en-US")} sources</button
    >
    ·
    <button
      type="button"
      onclick={onReadingRoom}
      class="text-warm-faint underline decoration-ink-border underline-offset-[3px] hover:text-warm-dim"
      >reading room</button
    >
  </p>
</div>

{#if loading && articles.length === 0}
  <div class="space-y-4">
    {#each [0, 1, 2, 3, 4] as row (row)}
      <div class="space-y-2 py-2">
        <Skeleton class="h-5 w-2/3 bg-ink-raised" />
        <Skeleton class="h-3 w-full bg-ink-raised" />
      </div>
    {/each}
  </div>
{:else if error}
  <p class="font-mono text-[length:var(--text-chrome)] text-destructive">
    {error}
  </p>
{:else if articles.length === 0}
  <div class="pt-6 text-center">
    <p class="mb-2 font-serif text-[length:var(--text-body)] text-warm-dim">
      No articles yet
    </p>
    <p
      class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
    >
      add sources from home, then update to write the library
    </p>
  </div>
{:else}
  {#if startHere.length > 0}
    <section class="mb-12">
      <h2
        class="mb-3 font-mono text-[length:var(--text-chrome)] tracking-[0.16em] text-gold-muted uppercase"
      >
        Start here
      </h2>
      <ol>
        {#each startHere as article, index (article.file_path)}
          <li class="border-t border-ink-subtle">
            <button
              type="button"
              onclick={() => onOpen(article)}
              class="group flex w-full gap-4 py-4 text-left focus-visible:outline-none"
            >
              <span
                class="mt-1 w-4 shrink-0 font-mono text-[length:var(--text-chrome)] text-gold-dim"
                >{index + 1}</span
              >
              <span class="min-w-0">
                <span
                  class="block font-serif text-[length:var(--text-body)] leading-snug text-warm group-hover:text-gold group-focus-visible:text-gold [overflow-wrap:anywhere]"
                  >{article.title}</span
                >
                {#if article.precis}
                  <span
                    class="mt-1.5 block font-serif text-[length:var(--text-small)] leading-[1.75] text-warm-faint"
                    >{article.precis}</span
                  >
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ol>
    </section>
  {/if}

  <section>
    <h2
      class="mb-3 font-mono text-[length:var(--text-chrome)] tracking-[0.16em] text-gold-muted uppercase"
    >
      All articles
    </h2>
    <nav
      aria-label="jump to letter"
      class="mb-2 flex flex-wrap gap-x-3 gap-y-1 border-y border-ink-subtle py-2.5 font-mono text-[length:var(--text-caption)] text-gold-muted"
    >
      {#each letters as [letter] (letter)}
        <button
          type="button"
          onclick={() => jump(`letter-${letter}`)}
          class="px-0.5 hover:text-gold">{letter}</button
        >
      {/each}
    </nav>
    {#each letters as [letter, group] (letter)}
      <div id={`letter-${letter}`} class="scroll-mt-4">
        <h3
          class="mt-7 mb-1.5 flex items-baseline justify-between font-mono text-[length:var(--text-caption)] tracking-[0.14em] text-gold"
        >
          {letter}
          <button
            type="button"
            onclick={() => jump("contents-top")}
            class="text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost hover:text-warm-faint"
            >↑ top</button
          >
        </h3>
        {#each group as article (article.file_path)}
          <button
            type="button"
            onclick={() => onOpen(article)}
            class="group block w-full border-t border-ink-subtle py-2.5 text-left focus-visible:outline-none"
          >
            <span
              class="block font-serif text-[length:var(--text-body)] leading-snug text-warm-dim group-hover:text-warm group-focus-visible:text-warm [overflow-wrap:anywhere]"
              >{article.title}</span
            >
            {#if article.precis}
              <span
                class="mt-1 line-clamp-2 font-serif text-[length:var(--text-small)] leading-[1.65] text-warm-ghost"
                >{article.precis}</span
              >
            {/if}
          </button>
        {/each}
      </div>
    {/each}
  </section>
{/if}
