<script lang="ts">
  import { goto } from "$app/navigation";

  import { auth } from "$lib/auth.svelte";
  import ArticlePanel from "$lib/components/article-panel.svelte";
  import ExploreContent from "$lib/components/explore-content.svelte";
  import PageHeader from "$lib/components/page-header.svelte";
  import PanelHost from "$lib/components/panel-host.svelte";
  import { useExplore } from "$lib/hooks/use-explore.svelte";
  import { usePanelCard } from "$lib/hooks/use-panel-card.svelte";

  const card = usePanelCard();
  const explore = useExplore(() => card.selectedCard);

  function updateNow() {
    explore.compileMutation.mutate(undefined, {
      onSuccess: (job) => void goto(`/pipeline/runs/${job.id}`),
    });
  }
</script>

<svelte:head>
  <title>Explore | Great Minds</title>
</svelte:head>

<PanelHost open={!!card.selectedCard} onClose={card.close}>
  {#snippet panel()}
    {#if card.selectedCard}
      <ArticlePanel
        card={card.selectedCard}
        content={explore.panel.data ?? null}
        loading={explore.panel.isLoading}
        onClose={card.close}
        onFullScreen={() => void goto(`/doc/${card.selectedCard?.label}`)}
        onOpenPath={card.openPath}
      />
    {/if}
  {/snippet}

  <div class="flex h-screen flex-col overflow-hidden">
    <PageHeader title="explore" onHome={() => void goto("/")} />

    <div class="min-h-0 flex-1 overflow-y-auto">
      <ExploreContent
        explore={{
          loading: explore.loading,
          recentArticles: explore.recentArticles,
          dirtyCount: explore.dirtyCount,
          orphans: explore.orphans,
          missing: explore.missing,
          compiling: explore.compileMutation.isPending,
          compileError: explore.compileMutation.error,
          canIngest: explore.currentVault?.owner_id === auth.userId,
          hasActivePipeline: explore.hasActivePipeline,
          usesR2: !!explore.currentVault?.r2_bucket_name,
        }}
        onOpenArticle={card.openArticle}
        onOpenSourceArticle={card.openSourceArticle}
        onUpdate={updateNow}
        onBrowseLibrary={() => void goto("/library")}
      />
    </div>
  </div>
</PanelHost>
