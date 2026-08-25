<script lang="ts">
  import IngestionFlow from "$lib/components/ingestion-flow.svelte";
  import HealthArticleRow from "$lib/components/health-article-row.svelte";
  import { Alert, AlertTitle } from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import type { UnmentionedLink, WikiArticleOverview } from "$lib/types";

  type HealthView = {
    status: "loading" | "ready" | "unavailable";
    checking: boolean;
    dirtyCount: number;
    orphans: WikiArticleOverview[];
    missing: UnmentionedLink[];
    compiling: boolean;
    compileError: Error | null;
    canManage: boolean;
    hasActivePipeline: boolean;
    stagedUploads: boolean;
    vaultName: string;
  };

  let {
    health,
    onOpenArticle,
    onOpenSourceArticle,
    onUpdate,
    onRetry,
    onBrowseLibrary,
  }: {
    health: HealthView;
    onOpenArticle: (article: WikiArticleOverview) => void;
    onOpenSourceArticle: (slug: string, title: string) => void;
    onUpdate: () => void;
    onRetry: () => void;
    onBrowseLibrary: () => void;
  } = $props();
</script>

<main class="mx-auto max-w-[740px] px-4 pt-8 pb-20 md:px-10">
  {#if health.status === "loading"}
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
  {:else if health.status === "unavailable"}
    <Alert
      variant="destructive"
      class="rounded-sm border-red-400/25 bg-red-400/5 p-5"
    >
      <AlertTitle
        class="mb-3 font-serif text-[length:var(--text-body)] text-warm-dim"
      >
        Health unavailable
      </AlertTitle>
      <Button
        variant="ghost"
        size="sm"
        onclick={onRetry}
        disabled={health.checking}
        class="h-auto rounded-sm px-3 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold hover:bg-transparent hover:text-gold-hover"
      >
        {health.checking ? "checking…" : "retry"}
      </Button>
    </Alert>
  {:else}
    {#if health.dirtyCount === 0 && health.orphans.length === 0 && health.missing.length === 0}
      <p class="mb-10 font-serif text-[length:var(--text-body)] text-warm-dim">
        Nothing needs attention — the wiki is healthy.
      </p>
    {/if}

    {#if health.dirtyCount > 0}
      <section class="mb-10">
        <div class="mb-4 flex items-center justify-between gap-4">
          <h2
            class="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
          >
            needs update
          </h2>
          {#if health.canManage}
            <Button
              variant="outline"
              size="sm"
              onclick={onUpdate}
              disabled={health.compiling}
              class="rounded-sm border-gold-dim font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold hover:bg-gold/10"
            >
              {health.compiling ? "compiling…" : "update now"}
            </Button>
          {/if}
        </div>
        <p class="font-serif text-[length:var(--text-body)] text-warm-dim">
          {health.dirtyCount} article{health.dirtyCount === 1 ? "" : "s"} drifted
          from the current topic registry and will be refreshed on the next update.
        </p>
        {#if health.compileError}
          <p
            class="mt-3 font-mono text-[length:var(--text-chrome)] text-destructive"
          >
            {health.compileError.message}
          </p>
        {/if}
      </section>
    {/if}

    {#if health.orphans.length > 0}
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
          {#each health.orphans as orphan (orphan.file_path)}
            <HealthArticleRow article={orphan} onOpen={onOpenArticle} />
          {/each}
        </div>
      </section>
    {/if}

    {#if health.missing.length > 0}
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
          {#each health.missing as connection, index (`${connection.source_slug}-${connection.target_slug}-${index}`)}
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

    {#if health.canManage}
      <div class="mt-10">
        <IngestionFlow
          hasActivePipeline={health.hasActivePipeline}
          stagedUploads={health.stagedUploads}
          vaultName={health.vaultName}
        />
      </div>
    {/if}
  {/if}
</main>
