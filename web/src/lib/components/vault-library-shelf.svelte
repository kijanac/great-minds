<script lang="ts">
  import ArticleRow from "$lib/components/article-row.svelte";
  import SourceRow from "$lib/components/source-row.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { LIBRARY_ALL, LIBRARY_ARTICLES } from "$lib/hooks/use-library.svelte";
  import type { SourceDocumentSummary, WikiArticleOverview } from "$lib/types";

  let {
    library,
    onOpenArticle,
    onOpenSource,
    onDeleteSource,
    onRequestDeletion,
  }: {
    library: {
      activeType: string;
      activeTag: string;
      search: string;
      articleItems: WikiArticleOverview[];
      pinArticle: WikiArticleOverview | null;
      sourceItems: SourceDocumentSummary[];
      loading: boolean;
      actionNotice: string | null;
      actionError: string | null;
      actionPath: string | null;
      role: string | null;
      articles: {
        hasNextPage: boolean;
        isFetchingNextPage: boolean;
        fetchNextPage: () => Promise<unknown>;
      };
      sources: {
        hasNextPage: boolean;
        isFetchingNextPage: boolean;
        fetchNextPage: () => Promise<unknown>;
      };
    };
    onOpenArticle: (article: WikiArticleOverview) => void;
    onOpenSource: (source: SourceDocumentSummary) => void;
    onDeleteSource: (path: string) => Promise<void>;
    onRequestDeletion: (path: string) => Promise<void>;
  } = $props();

  // The synthesis pin is a presentation-layer match on the active tag; it is
  // rendered as its own first row and excluded from the ordinary lists so it
  // never appears twice.
  const pin = $derived(library.pinArticle);
  const articleItems = $derived(
    pin
      ? library.articleItems.filter(
          (article) => article.file_path !== pin.file_path,
        )
      : library.articleItems,
  );
</script>

{#if pin}
  <section class="mb-10">
    <div class="mb-2 flex items-center gap-2">
      <span
        class="rounded-sm border border-gold-dim bg-gold/10 px-2 py-0.5 font-mono text-[10px] tracking-[0.1em] text-gold uppercase"
      >
        synthesis
      </span>
      <span
        class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost lowercase"
      >
        tag · {library.activeTag}
      </span>
    </div>
    <div class="rounded-sm border border-gold-dim/40 bg-gold/[0.03] px-1 py-1">
      <ArticleRow article={pin} onOpen={onOpenArticle} />
    </div>
  </section>
{/if}

{#if library.actionNotice}
  <p
    class="mb-3 px-3 font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-gold-muted"
  >
    {library.actionNotice}
  </p>
{/if}
{#if library.actionError}
  <p
    class="mb-3 px-3 font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-destructive"
  >
    {library.actionError}
  </p>
{/if}

{#if library.loading && library.articleItems.length === 0 && library.sourceItems.length === 0}
  <div class="space-y-3">
    {#each [0, 1, 2, 3] as row (row)}
      <div class="flex items-center justify-between gap-4 px-3 py-2.5">
        <div class="min-w-0 flex-1 space-y-2">
          <Skeleton class="h-5 w-2/3 bg-ink-raised" />
          <Skeleton class="h-3 w-1/2 bg-ink-raised" />
        </div>
        <Skeleton class="h-3 w-16 bg-ink-raised" />
      </div>
    {/each}
  </div>
{:else if library.articleItems.length === 0 && library.sourceItems.length === 0 && !pin}
  <div class="pt-8 text-center">
    <p class="mb-2 font-serif text-[length:var(--text-body)] text-warm-dim">
      {library.search
        ? "No library items match your search"
        : library.activeTag
          ? "No library items carry this tag"
          : "No library items yet"}
    </p>
    {#if !library.search && !library.activeTag}
      <p
        class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
      >
        add sources from home to build your library
      </p>
    {/if}
  </div>
{:else}
  {#if library.activeType === LIBRARY_ALL && articleItems.length > 0}
    <section class="mb-10">
      <h2
        class="mb-3 font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
      >
        articles
      </h2>
      <div class="space-y-1">
        {#each articleItems as article (article.file_path)}
          <ArticleRow {article} onOpen={onOpenArticle} />
        {/each}
      </div>
      {#if library.articles.hasNextPage}
        <div class="mt-4 text-center">
          <Button
            variant="ghost"
            onclick={() => void library.articles.fetchNextPage()}
            disabled={library.articles.isFetchingNextPage}
            class="h-auto px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:bg-transparent hover:text-gold"
          >
            {library.articles.isFetchingNextPage
              ? "loading…"
              : "load more articles"}
          </Button>
        </div>
      {/if}
    </section>
  {/if}

  {#if library.activeType !== LIBRARY_ARTICLES && library.sourceItems.length > 0}
    <section class="mb-10">
      {#if library.activeType === LIBRARY_ALL}
        <h2
          class="mb-3 font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
        >
          sources
        </h2>
      {/if}
      <div class="space-y-1">
        {#each library.sourceItems as source (source.file_path)}
          <SourceRow
            {source}
            role={library.role}
            busy={library.actionPath === source.file_path}
            onOpen={() => onOpenSource(source)}
            {onDeleteSource}
            {onRequestDeletion}
          />
        {/each}
      </div>
      {#if library.sources.hasNextPage}
        <div class="mt-4 text-center">
          <Button
            variant="ghost"
            onclick={() => void library.sources.fetchNextPage()}
            disabled={library.sources.isFetchingNextPage}
            class="h-auto px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:bg-transparent hover:text-gold"
          >
            {library.sources.isFetchingNextPage
              ? "loading…"
              : library.activeType === LIBRARY_ALL
                ? "load more sources"
                : "load more"}
          </Button>
        </div>
      {/if}
    </section>
  {/if}

  {#if library.activeType === LIBRARY_ARTICLES && articleItems.length > 0}
    <div class="space-y-1">
      {#each articleItems as article (article.file_path)}
        <ArticleRow {article} onOpen={onOpenArticle} />
      {/each}
    </div>
    {#if library.articles.hasNextPage}
      <div class="mt-6 text-center">
        <Button
          variant="ghost"
          onclick={() => void library.articles.fetchNextPage()}
          disabled={library.articles.isFetchingNextPage}
          class="h-auto px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:bg-transparent hover:text-gold"
        >
          {library.articles.isFetchingNextPage ? "loading…" : "load more"}
        </Button>
      </div>
    {/if}
  {/if}
{/if}
