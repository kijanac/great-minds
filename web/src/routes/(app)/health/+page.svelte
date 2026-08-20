<script lang="ts">
  import { goto } from "$app/navigation";

  import { auth } from "$lib/auth.svelte";
  import ArticlePanel from "$lib/components/article-panel.svelte";
  import HealthContent from "$lib/components/health-content.svelte";
  import PageHeader from "$lib/components/page-header.svelte";
  import PanelHost from "$lib/components/panel-host.svelte";
  import { useHealth } from "$lib/hooks/use-health.svelte";
  import { usePanelCard } from "$lib/hooks/use-panel-card.svelte";

  const card = usePanelCard();
  const health = useHealth(() => card.selectedCard);

  function updateNow() {
    health.compileMutation.mutate(undefined, {
      onSuccess: (job) => void goto(`/pipeline/runs/${job.id}`),
    });
  }
</script>

<svelte:head>
  <title>Health | Great Minds</title>
</svelte:head>

<PanelHost open={!!card.selectedCard} onClose={card.close}>
  {#snippet panel()}
    {#if card.selectedCard}
      <ArticlePanel
        card={card.selectedCard}
        content={health.panel.data ?? null}
        loading={health.panel.isLoading}
        onClose={card.close}
        onFullScreen={() => void goto(`/doc/${card.selectedCard?.label}`)}
        onOpenPath={card.openPath}
      />
    {/if}
  {/snippet}

  <div class="flex h-screen flex-col overflow-hidden">
    <PageHeader title="health" onHome={() => void goto("/")} />

    <div class="min-h-0 flex-1 overflow-y-auto">
      <HealthContent
        health={{
          loading: health.loading,
          dirtyCount: health.dirtyCount,
          orphans: health.orphans,
          missing: health.missing,
          compiling: health.compileMutation.isPending,
          compileError: health.compileMutation.error,
          canIngest: health.currentVault?.owner_id === auth.userId,
          hasActivePipeline: health.hasActivePipeline,
          usesR2: !!health.currentVault?.r2_bucket_name,
        }}
        onOpenArticle={card.openArticle}
        onOpenSourceArticle={card.openSourceArticle}
        onUpdate={updateNow}
        onBrowseLibrary={() => void goto("/library")}
      />
    </div>
  </div>
</PanelHost>
