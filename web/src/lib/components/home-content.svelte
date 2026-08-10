<script lang="ts">
  import { goto } from "$app/navigation";
  import { createQuery } from "@tanstack/svelte-query";
  import Download from "@lucide/svelte/icons/download";
  import FileText from "@lucide/svelte/icons/file-text";
  import Home from "@lucide/svelte/icons/home";
  import Printer from "@lucide/svelte/icons/printer";
  import { onDestroy, untrack } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { crossfade, fade } from "svelte/transition";

  import { auth } from "$lib/auth.svelte";
  import ArticlePanel from "$lib/components/article-panel.svelte";
  import IngestionFlow from "$lib/components/ingestion-flow.svelte";
  import PanelHost from "$lib/components/panel-host.svelte";
  import ProjectSwitcher from "$lib/components/project-switcher.svelte";
  import SearchBar from "$lib/components/search-bar.svelte";
  import SessionThread from "$lib/components/session-thread.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { useActiveJob } from "$lib/hooks/use-active-job.svelte";
  import { useExploreBadge } from "$lib/hooks/use-explore-badge.svelte";
  import { createLinkInterceptor } from "$lib/hooks/use-link-interceptor";
  import { useSessions } from "$lib/hooks/use-sessions.svelte";
  import { activeVault, useVaults } from "$lib/hooks/use-vault.svelte";
  import { MENU_ITEM_CLASS, POPOVER_SURFACE_CLASS } from "$lib/control-styles";
  import { loadPanelContent } from "$lib/panel-content";
  import { downloadSessionMarkdown } from "$lib/session-markdown";
  import { Session } from "$lib/session.svelte";
  import type { Exchange, SourceRef } from "$lib/types";

  let {
    sessionId,
    initialExchanges,
    initialQuery,
    origin,
  }: {
    sessionId?: string;
    initialExchanges?: Exchange[];
    initialQuery?: string;
    origin?: string;
  } = $props();

  const sessions = useSessions();
  const vaults = useVaults();
  const badge = useExploreBadge();
  const activeJob = useActiveJob();
  const initial = untrack(() => ({
    sessionId,
    initialExchanges,
    initialQuery,
    origin,
  }));
  let selectedCard = $state<SourceRef | null>(null);
  let query = $state(
    initial.initialQuery ?? initial.initialExchanges?.[0]?.query ?? "",
  );

  const session = new Session(
    initial.initialExchanges
      ? {
          initialExchanges: initial.initialExchanges,
          sessionId: initial.sessionId!,
        }
      : initial.initialQuery || initial.origin
        ? {
            initialQuery: initial.initialQuery,
            originPath: initial.origin,
            onSessionCreated: handleSessionCreated,
          }
        : { onSessionCreated: handleSessionCreated },
  );
  onDestroy(session.destroy);

  const [send, receive] = crossfade({
    duration: 280,
    easing: cubicOut,
  });
  const currentVault = $derived(
    vaults.data?.find((vault) => vault.id === activeVault.id) ?? null,
  );
  const badgeCount = $derived(
    (badge.data?.orphans.length ?? 0) +
      (badge.data?.dirty_topics.length ?? 0) +
      (badge.data?.unmentioned_links.length ?? 0),
  );
  const isActive = $derived(session.phase !== "idle");
  const panelQuery = createQuery(() => ({
    queryKey: [
      "vault",
      activeVault.id,
      "article-panel",
      selectedCard?.label,
      selectedCard?.ranges,
      selectedCard?.full,
    ],
    queryFn: ({ signal }) => loadPanelContent(selectedCard!, "vault", signal),
    enabled: !!activeVault.id && !!selectedCard,
  }));
  const handleLinkClick = createLinkInterceptor((citation) => {
    selectedCard = {
      label: citation.path,
      type: "raw",
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

  function handleSessionCreated(id: string) {
    window.history.replaceState(null, "", `/sessions/${id}`);
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
      />
    {/if}
  {/snippet}

  <div class="print-root relative flex h-screen overflow-hidden">
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
              <SearchBar bind:query phase={session.phase} onSubmit={submit} />
            </div>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <Button
                    {...props}
                    variant="ghost"
                    size="icon-xs"
                    aria-label="download session"
                    title="Download session"
                    class="shrink-0 text-muted-foreground hover:bg-transparent hover:text-gold"
                  >
                    <Download size={14} />
                  </Button>
                {/snippet}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content
                side="bottom"
                align="end"
                sideOffset={8}
                class={`w-auto min-w-0 p-1 ${POPOVER_SURFACE_CLASS}`}
              >
                <DropdownMenu.Item
                  onclick={() => window.print()}
                  class={`${MENU_ITEM_CLASS} cursor-pointer gap-2`}
                >
                  <Printer class="size-3.5" />
                  download as PDF
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  disabled={session.sessionId === null}
                  onclick={() => {
                    if (session.sessionId) {
                      void downloadSessionMarkdown(
                        session.sessionId,
                        session.thread,
                      );
                    }
                  }}
                  class={`${MENU_ITEM_CLASS} cursor-pointer gap-2`}
                >
                  <FileText class="size-3.5" />
                  export as markdown
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </div>
        </div>
      {/if}

      <div class="relative min-h-0 flex-1 overflow-hidden">
        {#if !isActive}
          <div
            class="absolute inset-0 flex flex-col items-center justify-center px-4 pb-12 md:px-10"
            out:fade={{ duration: 150 }}
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
                  usesR2={!!currentVault.r2_bucket_name}
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
</PanelHost>
