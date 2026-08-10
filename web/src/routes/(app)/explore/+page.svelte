<script lang="ts">
  import { goto } from "$app/navigation";
  import Home from "@lucide/svelte/icons/home";
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";

  import { fetchLintResults } from "$lib/api/explore";
  import { compile } from "$lib/api/compile";
  import { fetchSourceDocuments } from "$lib/api/sources";
  import {
    fetchRecentWikiArticles,
    type WikiArticleOverview,
  } from "$lib/api/wiki";
  import { auth } from "$lib/auth.svelte";
  import ArticlePanel from "$lib/components/article-panel.svelte";
  import IngestionFlow from "$lib/components/ingestion-flow.svelte";
  import PanelHost from "$lib/components/panel-host.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { activeVault, useVaults } from "$lib/hooks/use-vault.svelte";
  import { useActiveJob } from "$lib/hooks/use-active-job.svelte";
  import { loadPanelContent } from "$lib/panel-content";
  import type { SourceRef } from "$lib/types";
  import { formatShortDate } from "$lib/utils";

  const queryClient = useQueryClient();
  const vaults = useVaults();
  const activeJob = useActiveJob();
  let selectedCard = $state<SourceRef | null>(null);

  const currentVault = $derived(
    vaults.data?.find((vault) => vault.id === activeVault.id) ?? null,
  );

  const lint = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "explore-count"],
    queryFn: fetchLintResults,
    enabled: !!activeVault.id,
  }));

  const recent = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "recent-articles"],
    queryFn: () => fetchRecentWikiArticles(10),
    enabled: !!activeVault.id,
  }));

  const sourceFacets = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "source-facets"],
    queryFn: () => fetchSourceDocuments({ limit: 0 }),
    enabled: !!activeVault.id,
  }));

  const compileMutation = createMutation(() => ({
    mutationFn: () => compile(),
    onSuccess: async (job) => {
      await queryClient.invalidateQueries({
        queryKey: ["vault", activeVault.id, "active-job"],
      });
      await goto(`/pipeline/runs/${job.id}`);
    },
  }));

  const panelQuery = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "article-panel", selectedCard?.label],
    queryFn: ({ signal }) => loadPanelContent(selectedCard!, "vault", signal),
    enabled: !!activeVault.id && !!selectedCard,
  }));

  const orphans = $derived(lint.data?.orphans ?? []);
  const dirtyCount = $derived(lint.data?.dirty_topics.length ?? 0);
  const missing = $derived(lint.data?.unmentioned_links ?? []);
  const recentArticles = $derived(recent.data?.items ?? []);
  const loading = $derived(
    lint.isLoading || recent.isLoading || sourceFacets.isLoading,
  );
  const hasActivePipeline = $derived(activeJob.data ?? false);

  function openArticle(article: WikiArticleOverview) {
    selectedCard = {
      type: "article",
      label: article.file_path,
      title: article.title,
      scope: null,
      path: null,
      thinking: null,
    };
  }

  function openSourceArticle(slug: string, title: string) {
    selectedCard = {
      type: "article",
      label: `wiki/${slug}.md`,
      title,
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
</script>

<svelte:head>
  <title>Explore | Great Minds</title>
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
      class="flex shrink-0 items-center gap-4 border-b border-ink-subtle px-4 pt-4 pb-3 md:px-6"
    >
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
        explore
      </span>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <main class="mx-auto max-w-[740px] px-4 pt-8 pb-20 md:px-10">
        {#if loading}
          <div class="space-y-8">
            <div class="space-y-3">
              <Skeleton class="h-4 w-32 bg-ink-raised" />
              <Skeleton class="h-10 w-full bg-ink-raised" />
              <Skeleton class="h-10 w-5/6 bg-ink-raised" />
            </div>
            <div class="space-y-3">
              <Skeleton class="h-4 w-28 bg-ink-raised" />
              <Skeleton class="h-16 w-full bg-ink-raised" />
            </div>
          </div>
        {:else}
          <section class="mb-10">
            <h2
              class="mb-4 font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
            >
              recent articles
            </h2>
            {#if recentArticles.length > 0}
              <div class="space-y-1">
                {#each recentArticles as article (article.file_path)}
                  <Button
                    variant="ghost"
                    onclick={() => openArticle(article)}
                    class="group h-auto w-full justify-between rounded-sm px-3 py-2.5 hover:bg-ink-raised"
                  >
                    <span
                      class="truncate text-left font-serif text-[length:var(--text-body)] text-warm-dim transition-colors group-hover:text-warm"
                    >
                      {article.title}
                    </span>
                    <span
                      class="ml-4 shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
                    >
                      {formatShortDate(article.updated_at)}
                    </span>
                  </Button>
                {/each}
              </div>
            {:else}
              <p
                class="font-serif text-[length:var(--text-body)] text-warm-dim"
              >
                No articles yet.
              </p>
            {/if}
          </section>

          {#if dirtyCount > 0}
            <section class="mb-10">
              <div class="mb-4 flex items-center justify-between gap-4">
                <h2
                  class="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
                >
                  needs update
                </h2>
                <Button
                  variant="outline"
                  size="sm"
                  onclick={() => compileMutation.mutate()}
                  disabled={compileMutation.isPending}
                  class="rounded-sm border-gold-dim font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold hover:bg-gold/10"
                >
                  {compileMutation.isPending ? "compiling…" : "update now"}
                </Button>
              </div>
              <p
                class="font-serif text-[length:var(--text-body)] text-warm-dim"
              >
                {dirtyCount} article{dirtyCount === 1 ? "" : "s"} drifted from the
                current topic registry and will be refreshed on the next update.
              </p>
              {#if compileMutation.error}
                <p
                  class="mt-3 font-mono text-[length:var(--text-chrome)] text-destructive"
                >
                  {compileMutation.error.message}
                </p>
              {/if}
            </section>
          {/if}

          {#if orphans.length > 0}
            <section class="mb-10">
              <h2
                class="mb-4 font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
              >
                orphan articles
              </h2>
              <p
                class="mb-5 font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost"
              >
                rendered articles that no other article links to
              </p>
              <div class="space-y-1">
                {#each orphans as orphan (orphan.file_path)}
                  <Button
                    variant="ghost"
                    onclick={() => openArticle(orphan)}
                    class="group h-auto w-full justify-between rounded-sm px-3 py-2.5 hover:bg-ink-raised"
                  >
                    <span
                      class="truncate text-left font-serif text-[length:var(--text-body)] text-warm-dim transition-colors group-hover:text-warm"
                    >
                      {orphan.title}
                    </span>
                    <span
                      class="ml-4 shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
                    >
                      {formatShortDate(orphan.updated_at)}
                    </span>
                  </Button>
                {/each}
              </div>
            </section>
          {/if}

          {#if missing.length > 0}
            <section class="mb-10">
              <h2
                class="mb-4 font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
              >
                missing connections
              </h2>
              <p
                class="mb-5 font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost"
              >
                links the topic registry intended but the article doesn't
                include
              </p>
              <div class="space-y-1">
                {#each missing as connection, index (`${connection.source_slug}-${connection.target_slug}-${index}`)}
                  <button
                    type="button"
                    onclick={() =>
                      openSourceArticle(
                        connection.source_slug,
                        connection.source_title,
                      )}
                    class="group w-full rounded-sm px-3 py-2.5 text-left hover:bg-ink-raised focus-visible:bg-ink-raised focus-visible:outline-none"
                  >
                    <div
                      class="font-serif text-[length:var(--text-body)] text-warm-dim transition-colors group-hover:text-warm"
                    >
                      {connection.source_title}
                    </div>
                    <div
                      class="mt-0.5 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
                    >
                      → {connection.target_title}
                    </div>
                  </button>
                {/each}
              </div>
            </section>
          {/if}

          <a
            href="/library"
            onclick={(event) => {
              event.preventDefault();
              void goto("/library");
            }}
            class="font-serif text-[length:var(--text-small)] text-gold-muted transition-colors hover:text-gold"
          >
            browse the library →
          </a>

          {#if currentVault?.owner_id === auth.userId}
            <div class="mt-10">
              <IngestionFlow
                {hasActivePipeline}
                usesR2={!!currentVault.r2_bucket_name}
              />
            </div>
          {/if}
        {/if}
      </main>
    </div>
  </div>
</PanelHost>
