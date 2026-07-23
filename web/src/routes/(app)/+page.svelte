<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  import { auth } from "$lib/auth.svelte";
  import IngestionFlow from "$lib/components/ingestion-flow.svelte";
  import ProjectSwitcher from "$lib/components/project-switcher.svelte";
  import SearchBar from "$lib/components/search-bar.svelte";
  import { Button } from "$lib/components/ui/button";
  import { ErrorState, LoadingState } from "$lib/components/ui/feedback";
  import { useExploreBadge } from "$lib/hooks/use-explore-badge.svelte";
  import { useActiveJob } from "$lib/hooks/use-active-job.svelte";
  import { useSessions } from "$lib/hooks/use-sessions.svelte";
  import { activeVault, useVaults } from "$lib/hooks/use-vault.svelte";
  import type { Phase } from "$lib/types";

  const vaults = useVaults();
  const sessions = useSessions();
  const badge = useExploreBadge();
  const activeJob = useActiveJob();

  let query = $state("");
  const phase: Phase = "idle";
  const currentVault = $derived(
    vaults.data?.find((vault) => vault.id === activeVault.id) ?? null,
  );
  const badgeCount = $derived(
    (badge.data?.orphans.length ?? 0) +
      (badge.data?.dirty_topics.length ?? 0) +
      (badge.data?.unmentioned_links.length ?? 0),
  );
  const hasActivePipeline = $derived(activeJob.data ?? false);

  $effect(() => {
    const incomingQuery = page.url.searchParams.get("q");
    if (incomingQuery !== null) query = incomingQuery;
  });

  $effect(() => {
    if (!vaults.isLoading && (vaults.data?.length ?? 0) === 0) {
      void goto("/vaults/new", { replaceState: true });
    }
  });

  function submitQuery() {
    if (!query.trim()) return;
    // TODO(P4): hand the query to the Svelte session state machine.
  }
</script>

<svelte:head>
  <title>Great Minds</title>
</svelte:head>

{#if vaults.error}
  <ErrorState
    message="Couldn't load your projects."
    onRetry={() => void vaults.refetch()}
  />
{:else if vaults.isLoading}
  <LoadingState label="Loading…" />
{:else}
  <div
    class="flex h-screen flex-col items-center justify-center overflow-hidden px-4 pb-12 md:px-10"
  >
    <div class="mb-6 flex items-center gap-1.5">
      {#if currentVault}
        <Button
          variant="outline"
          onclick={() => void goto("/explore")}
          class="h-auto gap-2.5 rounded-sm border-ink-border px-4 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-warm-faint hover:border-gold-dim hover:text-warm"
        >
          {currentVault.name}
          {#if badgeCount > 0}
            <span
              class="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-gold/20 px-1 text-[10px] leading-none text-gold"
            >
              {badgeCount}
            </span>
          {/if}
        </Button>
      {/if}
      <ProjectSwitcher />
    </div>

    <div class="flex w-full max-w-[640px] items-center gap-3">
      <div class="min-w-0 flex-1">
        <SearchBar
          bind:query
          {phase}
          onSubmit={submitQuery}
          recentSessions={sessions.data?.items ?? []}
          sessionsLoading={sessions.isLoading}
          onSessionClick={(id) => void goto(`/sessions/${id}`)}
          onViewAllSessions={() => void goto("/sessions")}
        />
      </div>
    </div>

    {#if currentVault?.owner_id === auth.userId}
      <div
        class="flex min-h-[360px] w-full max-w-[800px] flex-col items-center justify-start pt-10"
      >
        <IngestionFlow
          {hasActivePipeline}
          usesR2={!!currentVault.r2_bucket_name}
        />
      </div>
    {/if}
  </div>
{/if}
