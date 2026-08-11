<script lang="ts">
  import IngestionFlow from "$lib/components/ingestion-flow.svelte";
  import ExploreArticleRow from "$lib/components/explore-article-row.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import type { UnmentionedLink, WikiArticleOverview } from "$lib/types";

  type ExploreView = {
    loading: boolean;
    recentArticles: WikiArticleOverview[];
    dirtyCount: number;
    orphans: WikiArticleOverview[];
    missing: UnmentionedLink[];
    compiling: boolean;
    compileError: Error | null;
    canIngest: boolean;
    hasActivePipeline: boolean;
    usesR2: boolean;
  };

  let {
    explore,
    onOpenArticle,
    onOpenSourceArticle,
    onUpdate,
    onBrowseLibrary,
  }: {
    explore: ExploreView;
    onOpenArticle: (article: WikiArticleOverview) => void;
    onOpenSourceArticle: (slug: string, title: string) => void;
    onUpdate: () => void;
    onBrowseLibrary: () => void;
  } = $props();
</script>

<main class="mx-auto max-w-[740px] px-4 pt-8 pb-20 md:px-10">
  {#if explore.loading}
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
      {#if explore.recentArticles.length > 0}
        <div class="space-y-1">
          {#each explore.recentArticles as article (article.file_path)}
            <ExploreArticleRow {article} onOpen={onOpenArticle} />
          {/each}
        </div>
      {:else}
        <p class="font-serif text-[length:var(--text-body)] text-warm-dim">
          No articles yet.
        </p>
      {/if}
    </section>

    {#if explore.dirtyCount > 0}
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
            onclick={onUpdate}
            disabled={explore.compiling}
            class="rounded-sm border-gold-dim font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold hover:bg-gold/10"
          >
            {explore.compiling ? "compiling…" : "update now"}
          </Button>
        </div>
        <p class="font-serif text-[length:var(--text-body)] text-warm-dim">
          {explore.dirtyCount} article{explore.dirtyCount === 1 ? "" : "s"} drifted
          from the current topic registry and will be refreshed on the next update.
        </p>
        {#if explore.compileError}
          <p
            class="mt-3 font-mono text-[length:var(--text-chrome)] text-destructive"
          >
            {explore.compileError.message}
          </p>
        {/if}
      </section>
    {/if}

    {#if explore.orphans.length > 0}
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
          {#each explore.orphans as orphan (orphan.file_path)}
            <ExploreArticleRow article={orphan} onOpen={onOpenArticle} />
          {/each}
        </div>
      </section>
    {/if}

    {#if explore.missing.length > 0}
      <section class="mb-10">
        <h2
          class="mb-4 font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
        >
          missing connections
        </h2>
        <p
          class="mb-5 font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost"
        >
          links the topic registry intended but the article doesn't include
        </p>
        <div class="space-y-1">
          {#each explore.missing as connection, index (`${connection.source_slug}-${connection.target_slug}-${index}`)}
            <button
              type="button"
              onclick={() =>
                onOpenSourceArticle(
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
        onBrowseLibrary();
      }}
      class="font-serif text-[length:var(--text-small)] text-gold-muted transition-colors hover:text-gold"
    >
      browse the library →
    </a>

    {#if explore.canIngest}
      <div class="mt-10">
        <IngestionFlow
          hasActivePipeline={explore.hasActivePipeline}
          usesR2={explore.usesR2}
        />
      </div>
    {/if}
  {/if}
</main>
