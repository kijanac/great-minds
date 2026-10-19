<script lang="ts">
  import { goto, replaceState } from "$app/navigation";
  import type { SessionId, SessionResponse } from "@great-minds/domain";
  import Download from "@lucide/svelte/icons/download";
  import Home from "@lucide/svelte/icons/home";
  import Share2 from "@lucide/svelte/icons/share-2";
  import { onDestroy, tick, untrack } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { crossfade, fade } from "svelte/transition";

  import { auth } from "$lib/auth.svelte";
  import ArticlePanel from "$lib/components/article-panel.svelte";
  import HealthIndicator from "$lib/components/health-indicator.svelte";
  import IngestionFlow from "$lib/components/ingestion-flow.svelte";
  import PanelHost from "$lib/components/panel-host.svelte";
  import VaultSwitcher from "$lib/components/vault-switcher.svelte";
  import SearchBar from "$lib/components/search-bar.svelte";
  import SessionThread from "$lib/components/session-thread.svelte";
  import SessionExport from "$lib/components/session-export.svelte";
  import ShareDialog from "$lib/components/share-dialog.svelte";
  import { Button } from "$lib/components/ui/button";
  import { useActiveJob } from "$lib/hooks/use-active-job.svelte";
  import { useHealthReport } from "$lib/hooks/use-health-report.svelte";
  import { createLinkInterceptor } from "$lib/hooks/use-link-interceptor";
  import { usePanelContent } from "$lib/hooks/use-panel-content.svelte";
  import { useSessions } from "$lib/hooks/use-sessions.svelte";
  import { useVaultCounts } from "$lib/hooks/use-vault-counts.svelte";
  import { activeVault, useVaults } from "$lib/hooks/use-vault.svelte";
  import { useSessionExport } from "$lib/hooks/use-session-export.svelte";
  import { Session } from "$lib/session.svelte";
  import type { SourceRef } from "$lib/types";

  let {
    saved,
    initialQuery,
    origin,
  }: {
    saved?: SessionResponse;
    initialQuery?: string;
    origin?: string;
  } = $props();

  const sessions = useSessions();
  const vaults = useVaults();
  const health = useHealthReport();
  const counts = useVaultCounts();
  const activeJob = useActiveJob();
  const initial = untrack(() => ({
    saved,
    initialQuery,
    origin,
  }));
  let selectedCard = $state<SourceRef | null>(null);

  const session = new Session({
    saved: initial.saved,
    initialQuery: initial.initialQuery,
    originPath: initial.origin,
    onOpenSession: (id) => void goto(`/sessions/${id}`),
    onSessionCreated: handleSessionCreated,
  });
  onDestroy(session.destroy);
  const publication = useSessionExport(() => session.sessionId);
  let exportButton = $state<HTMLButtonElement | HTMLAnchorElement | null>(null);
  async function closeExport() {
    publication.close();
    await tick();
    exportButton?.focus();
  }
  const exportBusy = $derived(session.phase !== "done");
  let query = $state(initial.initialQuery ?? session.thread[0]?.query ?? "");

  const [send, receive] = crossfade({
    duration: 280,
    easing: cubicOut,
  });
  const currentVault = $derived(
    vaults.data?.find((vault) => vault.id === activeVault.id) ?? null,
  );

  const isActive = $derived(session.phase !== "idle");
  const panelQuery = usePanelContent(() => selectedCard);
  const handleLinkClick = createLinkInterceptor((citation) => {
    selectedCard = {
      label: citation.path,
      type: "raw",
      document_id: null,
      title: null,
      scope: null,
      path: null,
      thinking: null,
      ranges:
        citation.chunk == null
          ? undefined
          : [{ start: citation.chunk, end: citation.chunk }],
      full: citation.chunk == null,
    };
  });

  function handleSessionCreated(id: SessionId) {
    replaceState(`/sessions/${id}`, {});
    void sessions.refetch();
  }

  function submit() {
    if (!query.trim()) return;
    session.submitQuery(query);
  }

  function toggleCard(source: SourceRef) {
    selectedCard =
      selectedCard?.label === source.label
        ? null
        : {
            ...source,
            ranges: source.ranges?.map((range) => ({ ...range })),
          };
  }
</script>

<PanelHost open={!!selectedCard} onClose={() => (selectedCard = null)}>
  {#snippet panel()}
    {#if selectedCard}
      <ArticlePanel
        card={selectedCard}
        content={panelQuery.data ?? null}
        loading={panelQuery.isLoading}
        context="agent"
        onClose={() => (selectedCard = null)}
        onFullScreen={() => void goto(`/doc/${selectedCard?.label}`)}
        onOpenPath={(path) => void goto(`/doc/${path}`)}
        onLinkClick={handleLinkClick}
      />
    {/if}
  {/snippet}

  <div class="relative flex h-screen overflow-hidden">
    <div class="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      {#if isActive}
        <div
          class="shrink-0 border-b border-ink-subtle px-4 pt-[22px] pb-[18px] md:px-10"
          in:fade={{ duration: 150 }}
        >
          <div
            class="flex w-full items-center gap-3"
            in:receive={{ key: "search-bar" }}
          >
            <Button
              variant="ghost"
              size="icon-xs"
              onclick={() => void goto("/")}
              aria-label="home"
              class="shrink-0 text-muted-foreground hover:bg-transparent hover:text-gold"
            >
              <Home size={14} />
            </Button>
            <div class="min-w-0 flex-1">
              {#if !session.origin?.anchor}
                <SearchBar bind:query phase={session.phase} onSubmit={submit} />
              {/if}
            </div>
            {#if session.sessionId}
              <ShareDialog subjectKind="session" subjectId={session.sessionId}>
                {#snippet trigger({ props })}
                  <Button
                    {...props}
                    variant="ghost"
                    size="icon-xs"
                    aria-label="share session"
                    title="Share session"
                    class="shrink-0 text-muted-foreground hover:bg-transparent hover:text-gold"
                  >
                    <Share2 size={14} />
                  </Button>
                {/snippet}
              </ShareDialog>
            {/if}
            <Button
              variant="ghost"
              disabled={session.sessionId === null ||
                exportBusy ||
                publication.pending}
              title={exportBusy
                ? "Available when the conversation finishes saving"
                : "Export conversation"}
              aria-label="Export conversation"
              bind:ref={exportButton}
              onclick={() => {
                selectedCard = null;
                publication.prepare();
              }}
              class="min-h-11 shrink-0 rounded-sm font-mono text-xs text-muted-foreground hover:bg-transparent hover:text-gold"
            >
              <Download size={14} /> Export
            </Button>
          </div>
        </div>
      {/if}

      <div class="relative min-h-0 flex-1 overflow-hidden">
        {#if publication.open}
          <SessionExport
            pending={publication.pending}
            error={publication.error}
            prepared={publication.prepared}
            paper={publication.paper}
            onPaperChange={publication.changePaper}
            onPrepare={publication.prepare}
            onMarkdown={publication.prepareMarkdown}
            onClose={() => void closeExport()}
          />
        {/if}
        <div class="h-full" hidden={publication.open}>
          {#if !isActive}
            <div
              class="absolute inset-0 flex flex-col items-center justify-center px-4 pb-12 md:px-10"
              out:fade={{ duration: 150 }}
            >
              <div
                class="mb-6 flex w-full max-w-[640px] items-center justify-center gap-1.5"
              >
                {#if currentVault}
                  <Button
                    variant="outline"
                    onclick={() => void goto("/library")}
                    class="h-auto min-w-0 shrink flex-col items-start gap-1 rounded-sm border-ink-border px-4 py-1.5 text-left font-mono text-[length:var(--text-chrome)] tracking-[0.14em] whitespace-normal text-warm-faint hover:border-gold-dim hover:text-warm sm:flex-row sm:items-center sm:gap-2.5"
                  >
                    <span class="min-w-0 [overflow-wrap:anywhere]"
                      >{currentVault.name}</span
                    >
                    {#if counts.articleTotal !== null && counts.sourceTotal !== null}
                      <span
                        class="text-warm-ghost group-hover/button:text-warm"
                      >
                        {counts.articleTotal}&nbsp;article{counts.articleTotal ===
                        1
                          ? ""
                          : "s"} · {counts.sourceTotal}&nbsp;source{counts.sourceTotal ===
                        1
                          ? ""
                          : "s"} →
                      </span>
                    {/if}
                  </Button>
                  <HealthIndicator
                    status={health.status}
                    count={health.count}
                    onOpen={() => void goto("/health")}
                  />
                {/if}
                <VaultSwitcher />
              </div>

              <div
                class="flex w-full max-w-[640px] items-center gap-3"
                out:send={{ key: "search-bar" }}
              >
                <div class="min-w-0 flex-1">
                  <SearchBar
                    bind:query
                    phase={session.phase}
                    onSubmit={submit}
                    recentSessions={sessions.data?.items ?? []}
                    sessionsLoading={sessions.isLoading}
                    submissionFailed={session.submission.status === "failed"}
                    onQueryChange={session.clearSubmissionFailure}
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
                    hasActivePipeline={activeJob.data ?? false}
                    vaultName={currentVault.name}
                  />
                </div>
              {/if}
            </div>
          {:else}
            <div
              class="flex h-full min-h-0 flex-col"
              in:fade={{ duration: 200, delay: 100 }}
            >
              <SessionThread
                {session}
                activeCard={selectedCard?.label ?? null}
                panelDocked={!!selectedCard}
                onCardClick={toggleCard}
                onLinkClick={handleLinkClick}
              />
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
</PanelHost>
