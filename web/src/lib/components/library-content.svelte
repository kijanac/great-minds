<script lang="ts">
  import ArticleRow from "$lib/components/article-row.svelte";
  import LibraryFilterChips from "$lib/components/library-filter-chips.svelte";
  import SourceRow from "$lib/components/source-row.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { LIBRARY_ALL, LIBRARY_ARTICLES } from "$lib/hooks/use-library.svelte";
  import type {
    SourceDocumentSummary,
    SourceTypeFacet,
    WikiArticleOverview,
  } from "$lib/types";

  type LibraryView = {
    activeType: string;
    search: string;
    sourceFacets: SourceTypeFacet[];
    totalCount: number;
    articleTotal: number;
    articleItems: WikiArticleOverview[];
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

  let {
    library,
    onChooseType,
    onOpenArticle,
    onOpenSource,
    onDeleteSource,
    onRequestDeletion,
  }: {
    library: LibraryView;
    onChooseType: (value: string) => void;
    onOpenArticle: (article: WikiArticleOverview) => void;
    onOpenSource: (source: SourceDocumentSummary) => void;
    onDeleteSource: (path: string) => Promise<void>;
    onRequestDeletion: (path: string) => Promise<void>;
  } = $props();
</script>

<main class="mx-auto max-w-[740px] px-4 pt-8 pb-20 md:px-10">
  <LibraryFilterChips
    activeType={library.activeType}
    totalCount={library.totalCount}
    articleTotal={library.articleTotal}
    sourceFacets={library.sourceFacets}
    onChange={onChooseType}
  />

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
  {:else if library.articleItems.length === 0 && library.sourceItems.length === 0}
    <div class="pt-8 text-center">
      <p class="mb-2 font-serif text-[length:var(--text-body)] text-warm-dim">
        {library.search
          ? "No library items match your search"
          : "No library items yet"}
      </p>
      {#if !library.search}
        <p
          class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
        >
          add sources from explore to build your library
        </p>
      {/if}
    </div>
  {:else}
    {#if library.activeType === LIBRARY_ALL && library.articleItems.length > 0}
      <section class="mb-10">
        <h2
          class="mb-3 font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
        >
          articles
        </h2>
        <div class="space-y-1">
          {#each library.articleItems as article (article.file_path)}
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
              onOpen={onOpenSource}
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

    {#if library.activeType === LIBRARY_ARTICLES && library.articleItems.length > 0}
      <div class="space-y-1">
        {#each library.articleItems as article (article.file_path)}
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
</main>
