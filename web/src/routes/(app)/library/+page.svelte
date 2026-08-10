<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import Home from "@lucide/svelte/icons/home";
  import Search from "@lucide/svelte/icons/search";
  import {
    createInfiniteQuery,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";

  import {
    deleteSourceDocument,
    fetchSourceDocuments,
    requestSourceDeletion,
    type SourceDocumentSummary,
  } from "$lib/api/sources";
  import { getVaultDetail } from "$lib/api/vaults";
  import { fetchWikiArticles, type WikiArticleOverview } from "$lib/api/wiki";
  import ArticlePanel from "$lib/components/article-panel.svelte";
  import PanelHost from "$lib/components/panel-host.svelte";
  import SourceActionButton from "$lib/components/source-action-button.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as ToggleGroup from "$lib/components/ui/toggle-group";
  import { FILTER_CHIP_CLASS } from "$lib/control-styles";
  import { activeVault } from "$lib/hooks/use-vault.svelte";
  import { loadPanelContent } from "$lib/panel-content";
  import type { SourceRef } from "$lib/types";
  import { displayTitle, formatShortDate } from "$lib/utils";

  const PAGE_SIZE = 50;
  const ALL = "all";
  const ARTICLES = "articles";

  const queryClient = useQueryClient();
  let search = $state("");
  let debouncedSearch = $state("");
  let selectedCard = $state<SourceRef | null>(null);
  let actionPath = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let actionNotice = $state<string | null>(null);

  const activeType = $derived(page.url.searchParams.get("type") || ALL);
  const sourceType = $derived(
    activeType === ALL || activeType === ARTICLES ? undefined : activeType,
  );

  $effect(() => {
    const value = search;
    const timeout = window.setTimeout(() => {
      debouncedSearch = value.trim();
    }, 300);
    return () => window.clearTimeout(timeout);
  });

  const facets = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "library-facets", debouncedSearch],
    queryFn: () =>
      fetchSourceDocuments({
        search: debouncedSearch || undefined,
        limit: 0,
      }),
    enabled: !!activeVault.id,
  }));

  const articleCount = createQuery(() => ({
    queryKey: [
      "vault",
      activeVault.id,
      "library-article-count",
      debouncedSearch,
    ],
    queryFn: () =>
      fetchWikiArticles({
        contains: debouncedSearch || undefined,
        limit: 1,
      }),
    enabled: !!activeVault.id,
  }));

  const articles = createInfiniteQuery(() => ({
    queryKey: ["vault", activeVault.id, "library-articles", debouncedSearch],
    queryFn: ({ pageParam }) =>
      fetchWikiArticles({
        contains: debouncedSearch || undefined,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const next = lastPage.pagination.offset + lastPage.items.length;
      return next < lastPage.pagination.total ? next : undefined;
    },
    enabled:
      !!activeVault.id && (activeType === ALL || activeType === ARTICLES),
  }));

  const sources = createInfiniteQuery(() => ({
    queryKey: [
      "vault",
      activeVault.id,
      "library-sources",
      sourceType ?? ALL,
      debouncedSearch,
    ],
    queryFn: ({ pageParam }) =>
      fetchSourceDocuments({
        source_type: sourceType,
        search: debouncedSearch || undefined,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const next = lastPage.pagination.offset + lastPage.items.length;
      return next < lastPage.pagination.total ? next : undefined;
    },
    enabled: !!activeVault.id && activeType !== ARTICLES,
  }));

  const roleQuery = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "detail"],
    queryFn: () => getVaultDetail(activeVault.id!),
    enabled: !!activeVault.id,
  }));

  const panelQuery = createQuery(() => ({
    queryKey: [
      "vault",
      activeVault.id,
      "article-panel",
      selectedCard?.type,
      selectedCard?.label,
      selectedCard?.ranges,
      selectedCard?.full,
    ],
    queryFn: ({ signal }) => loadPanelContent(selectedCard!, "vault", signal),
    enabled: !!activeVault.id && !!selectedCard,
  }));

  const sourceFacets = $derived(facets.data?.facets.source_types ?? []);
  const sourceTotal = $derived(
    sourceFacets.reduce((sum, facet) => sum + facet.count, 0),
  );
  const articleTotal = $derived(
    articleCount.data?.pagination.total ??
      articles.data?.pages[0]?.pagination.total ??
      0,
  );
  const totalCount = $derived(articleTotal + sourceTotal);
  // Header count reflects the current search scope; the facet chips keep
  // whole-vault counts (the facets response ignores search — API behavior).
  const sourceListTotal = $derived(
    sources.data?.pages[0]?.pagination.total ?? sourceTotal,
  );
  const headerCount = $derived(articleTotal + sourceListTotal);
  const articleItems = $derived(
    articles.data?.pages.flatMap((result) => result.items) ?? [],
  );
  const sourceItems = $derived(
    sources.data?.pages.flatMap((result) => result.items) ?? [],
  );
  const loading = $derived(
    articles.isLoading ||
      sources.isLoading ||
      facets.isLoading ||
      articleCount.isLoading,
  );

  function chooseType(value: string) {
    const params = new URLSearchParams(page.url.searchParams);
    if (!value || value === ALL) params.delete("type");
    else params.set("type", value);
    const query = params.toString();
    void goto(`/library${query ? `?${query}` : ""}`, {
      replaceState: true,
      keepFocus: true,
      noScroll: true,
    });
  }

  function openArticle(item: WikiArticleOverview) {
    selectedCard = {
      type: "article",
      label: item.file_path,
      title: item.title,
      scope: null,
      path: null,
      thinking: null,
    };
  }

  function openSource(item: SourceDocumentSummary) {
    selectedCard = {
      type: "raw",
      label: item.file_path,
      title: item.title,
      scope: null,
      path: null,
      thinking: null,
    };
  }

  function openPath(path: string) {
    selectedCard = {
      type: path.startsWith("wiki/") ? "article" : "raw",
      label: path,
      title: null,
      scope: null,
      path: null,
      thinking: null,
    };
  }

  async function refreshSources() {
    await queryClient.invalidateQueries({
      queryKey: ["vault", activeVault.id, "library-sources"],
    });
    await queryClient.invalidateQueries({
      queryKey: ["vault", activeVault.id, "library-facets"],
    });
  }

  async function deleteSource(path: string) {
    actionPath = path;
    actionError = null;
    actionNotice = null;
    try {
      await deleteSourceDocument(path);
      if (selectedCard?.label === path) selectedCard = null;
      await refreshSources();
    } catch (error) {
      actionError =
        error instanceof Error ? error.message : "Failed to delete source";
      throw error;
    } finally {
      actionPath = null;
    }
  }

  async function requestDeletion(path: string) {
    actionPath = path;
    actionError = null;
    actionNotice = null;
    try {
      await requestSourceDeletion(path);
      actionNotice = "Deletion request submitted.";
    } catch (error) {
      actionError =
        error instanceof Error
          ? error.message
          : "Failed to request source deletion";
      throw error;
    } finally {
      actionPath = null;
    }
  }
</script>

<svelte:head>
  <title>Library | Great Minds</title>
</svelte:head>

<PanelHost open={!!selectedCard} onClose={() => (selectedCard = null)}>
  {#snippet panel()}
    {#if selectedCard}
      <ArticlePanel
        card={selectedCard}
        content={panelQuery.data ?? null}
        loading={panelQuery.isLoading}
        onClose={() => (selectedCard = null)}
        onFullScreen={() => void goto(`/doc/${selectedCard?.label}`)}
        onOpenPath={openPath}
      />
    {/if}
  {/snippet}

  <div class="flex h-screen flex-col overflow-hidden">
    <header
      class="flex shrink-0 items-center justify-between gap-3 border-b border-ink-subtle px-4 pt-4 pb-3 md:px-6"
    >
      <div class="flex shrink-0 items-center gap-4">
        <Button
          variant="ghost"
          size="icon-xs"
          onclick={() => void goto("/")}
          aria-label="home"
          class="text-muted-foreground hover:bg-transparent hover:text-gold"
        >
          <Home size={14} />
        </Button>
        <span
          class="hidden font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase md:inline"
        >
          library
        </span>
        {#if totalCount > 0}
          <span
            class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
          >
            {headerCount}
          </span>
        {/if}
      </div>

      <div class="flex w-full max-w-[300px] items-center gap-2">
        <Search size={14} class="shrink-0 text-muted-foreground" />
        <Input
          bind:value={search}
          class="h-7 rounded-sm border-ink-border bg-transparent px-3 font-serif text-[length:var(--text-small)] text-foreground caret-gold placeholder:text-input focus-visible:border-gold-dim focus-visible:ring-0 dark:bg-transparent"
          placeholder="Search library..."
        />
      </div>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <main class="mx-auto max-w-[740px] px-4 pt-8 pb-20 md:px-10">
        <ToggleGroup.Root
          type="single"
          value={activeType}
          onValueChange={chooseType}
          variant="outline"
          size="sm"
          class="mb-8 flex-wrap"
        >
          <ToggleGroup.Item value={ALL} class={FILTER_CHIP_CLASS}>
            all · {totalCount}
          </ToggleGroup.Item>
          <ToggleGroup.Item value={ARTICLES} class={FILTER_CHIP_CLASS}>
            articles · {articleTotal}
          </ToggleGroup.Item>
          {#each sourceFacets as facet (facet.value)}
            <ToggleGroup.Item value={facet.value} class={FILTER_CHIP_CLASS}>
              {facet.value} · {facet.count}
            </ToggleGroup.Item>
          {/each}
        </ToggleGroup.Root>

        {#if actionNotice}
          <p
            class="mb-3 px-3 font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-gold-muted"
          >
            {actionNotice}
          </p>
        {/if}
        {#if actionError}
          <p
            class="mb-3 px-3 font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-destructive"
          >
            {actionError}
          </p>
        {/if}

        {#if loading && articleItems.length === 0 && sourceItems.length === 0}
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
        {:else if articleItems.length === 0 && sourceItems.length === 0}
          <div class="pt-8 text-center">
            <p
              class="mb-2 font-serif text-[length:var(--text-body)] text-warm-dim"
            >
              {search
                ? "No library items match your search"
                : "No library items yet"}
            </p>
            {#if !search}
              <p
                class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
              >
                add sources from explore to build your library
              </p>
            {/if}
          </div>
        {:else}
          {#if activeType === ALL && articleItems.length > 0}
            <section class="mb-10">
              <h2
                class="mb-3 font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
              >
                articles
              </h2>
              <div class="space-y-1">
                {#each articleItems as item (item.file_path)}
                  <button
                    type="button"
                    onclick={() => openArticle(item)}
                    class="group flex w-full items-start justify-between gap-4 rounded-sm px-3 py-3 text-left hover:bg-ink-raised focus-visible:bg-ink-raised focus-visible:outline-none"
                  >
                    <span class="min-w-0 flex-1">
                      <span
                        class="block truncate font-serif text-[length:var(--text-body)] text-warm-dim transition-colors group-hover:text-warm"
                      >
                        {item.title}
                      </span>
                      {#if item.precis}
                        <span
                          class="mt-1 line-clamp-2 block font-serif text-[length:var(--text-small)] text-warm-ghost"
                        >
                          {item.precis}
                        </span>
                      {/if}
                    </span>
                    <span
                      class="mt-0.5 shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
                    >
                      {formatShortDate(item.updated_at)}
                    </span>
                  </button>
                {/each}
              </div>
              {#if articles.hasNextPage}
                <div class="mt-4 text-center">
                  <Button
                    variant="ghost"
                    onclick={() => void articles.fetchNextPage()}
                    disabled={articles.isFetchingNextPage}
                    class="h-auto px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:bg-transparent hover:text-gold"
                  >
                    {articles.isFetchingNextPage
                      ? "loading…"
                      : "load more articles"}
                  </Button>
                </div>
              {/if}
            </section>
          {/if}

          {#if activeType !== ARTICLES && sourceItems.length > 0}
            <section class="mb-10">
              {#if activeType === ALL}
                <h2
                  class="mb-3 font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
                >
                  sources
                </h2>
              {/if}
              <div class="space-y-1">
                {#each sourceItems as item (item.file_path)}
                  <div
                    class="group flex min-h-12 items-center gap-2 rounded-sm hover:bg-ink-raised focus-within:bg-ink-raised"
                  >
                    <button
                      type="button"
                      onclick={() => openSource(item)}
                      class="flex min-w-0 flex-1 items-center justify-between gap-4 py-2.5 pr-1 pl-3 text-left focus-visible:outline-none"
                    >
                      <span class="min-w-0 flex-1">
                        <span
                          class="block truncate font-serif text-[length:var(--text-body)] text-warm-dim transition-colors group-hover:text-warm"
                        >
                          {displayTitle(item.file_path, item.title)}
                        </span>
                        {#if item.author || item.origin}
                          <span
                            class="mt-0.5 block truncate font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost"
                          >
                            {[item.author, item.origin]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        {/if}
                      </span>
                      <span
                        class="shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
                      >
                        {formatShortDate(item.updated_at)}
                      </span>
                    </button>
                    <SourceActionButton
                      {item}
                      role={roleQuery.data?.role ?? null}
                      busy={actionPath === item.file_path}
                      onDeleteSource={deleteSource}
                      onRequestDeletion={requestDeletion}
                    />
                  </div>
                {/each}
              </div>
              {#if sources.hasNextPage}
                <div class="mt-4 text-center">
                  <Button
                    variant="ghost"
                    onclick={() => void sources.fetchNextPage()}
                    disabled={sources.isFetchingNextPage}
                    class="h-auto px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:bg-transparent hover:text-gold"
                  >
                    {sources.isFetchingNextPage
                      ? "loading…"
                      : activeType === ALL
                        ? "load more sources"
                        : "load more"}
                  </Button>
                </div>
              {/if}
            </section>
          {/if}

          {#if activeType === ARTICLES && articleItems.length > 0}
            <div class="space-y-1">
              {#each articleItems as item (item.file_path)}
                <button
                  type="button"
                  onclick={() => openArticle(item)}
                  class="group flex w-full items-start justify-between gap-4 rounded-sm px-3 py-3 text-left hover:bg-ink-raised focus-visible:bg-ink-raised focus-visible:outline-none"
                >
                  <span class="min-w-0 flex-1">
                    <span
                      class="block truncate font-serif text-[length:var(--text-body)] text-warm-dim transition-colors group-hover:text-warm"
                    >
                      {item.title}
                    </span>
                    {#if item.precis}
                      <span
                        class="mt-1 line-clamp-2 block font-serif text-[length:var(--text-small)] text-warm-ghost"
                      >
                        {item.precis}
                      </span>
                    {/if}
                  </span>
                  <span
                    class="mt-0.5 shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
                  >
                    {formatShortDate(item.updated_at)}
                  </span>
                </button>
              {/each}
            </div>
            {#if articles.hasNextPage}
              <div class="mt-6 text-center">
                <Button
                  variant="ghost"
                  onclick={() => void articles.fetchNextPage()}
                  disabled={articles.isFetchingNextPage}
                  class="h-auto px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:bg-transparent hover:text-gold"
                >
                  {articles.isFetchingNextPage ? "loading…" : "load more"}
                </Button>
              </div>
            {/if}
          {/if}
        {/if}
      </main>
    </div>
  </div>
</PanelHost>
