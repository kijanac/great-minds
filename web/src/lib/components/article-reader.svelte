<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { createQuery } from "@tanstack/svelte-query";
  import { tick } from "svelte";

  import ArticleChrome from "$lib/components/article-chrome.svelte";
  import ArticlePanel from "$lib/components/article-panel.svelte";
  import ArticleView from "$lib/components/article-view.svelte";
  import PanelHost from "$lib/components/panel-host.svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { activeVault } from "$lib/hooks/use-vault.svelte";
  import { useDocument } from "$lib/hooks/use-document.svelte";
  import {
    createLinkInterceptor,
    type RawCitation,
  } from "$lib/hooks/use-link-interceptor";
  import { loadPanelContent } from "$lib/panel-content";
  import type { SourceRef } from "$lib/types";
  import { displayTitle } from "$lib/utils";

  let { path }: { path: string } = $props();

  let selectedCard = $state<SourceRef | null>(null);
  const documentQuery = useDocument(() => path);
  const document = $derived(documentQuery.data?.article ?? null);
  const body = $derived(documentQuery.data?.body ?? null);
  const label = $derived(displayTitle(path, document?.title));

  const panelQuery = createQuery(() => ({
    queryKey: [
      "vault",
      activeVault.id,
      "article-panel",
      selectedCard?.label,
      selectedCard?.ranges,
      selectedCard?.full,
    ],
    queryFn: ({ signal }) => loadPanelContent(selectedCard!, signal),
    enabled: !!activeVault.id && !!selectedCard,
  }));

  function openRawCitation(citation: RawCitation) {
    selectedCard = {
      type: "raw",
      label: citation.path,
      title: null,
      ranges:
        citation.chunk == null
          ? undefined
          : [{ start: citation.chunk, end: citation.chunk }],
      full: citation.chunk == null,
    };
  }

  const handleLinkClick = createLinkInterceptor(openRawCitation);

  function openPanelPath(linkedPath: string) {
    if (linkedPath.startsWith("wiki/")) {
      selectedCard = null;
      void goto(`/doc/${linkedPath}`);
      return;
    }
    selectedCard = {
      type: "raw",
      label: linkedPath,
      title: null,
      full: true,
    };
  }

  async function maximizePanel() {
    const card = selectedCard;
    if (!card) return;
    const range = card.ranges?.length === 1 ? card.ranges[0] : null;
    const hash = range && range.start === range.end ? `#^p${range.start}` : "";
    selectedCard = null;
    await goto(`/doc/${card.label}${hash}`);
  }

  $effect(() => {
    const hash = page.url.hash;
    const renderedBody = body;
    const currentPath = path;
    if (!hash || renderedBody === null || !currentPath) return;

    void tick().then(() => {
      const target = window.document.getElementById(
        decodeURIComponent(hash.slice(1)),
      );
      target?.scrollIntoView({ block: "start" });
    });
  });
</script>

<PanelHost open={!!selectedCard} onClose={() => (selectedCard = null)}>
  {#snippet panel()}
    {#if selectedCard}
      <ArticlePanel
        card={selectedCard}
        content={panelQuery.data ?? null}
        loading={panelQuery.isLoading}
        context="citation"
        onClose={() => (selectedCard = null)}
        onFullScreen={() => void maximizePanel()}
        onOpenPath={openPanelPath}
      />
    {/if}
  {/snippet}

  <ArticleChrome
    {label}
    onHome={() => void goto("/")}
    onQuery={(question) =>
      void goto(
        `/?q=${encodeURIComponent(question)}&origin=${encodeURIComponent(path)}`,
      )}
  >
    {#if documentQuery.isLoading}
      <div class="mx-auto max-w-[740px] space-y-4 px-4 pt-10 md:px-10">
        <Skeleton class="h-8 w-2/3 bg-ink-raised" />
        <Skeleton class="h-4 w-1/2 bg-ink-raised" />
        <Skeleton class="mt-10 h-4 w-full bg-ink-raised" />
        <Skeleton class="h-4 w-11/12 bg-ink-raised" />
        <Skeleton class="h-4 w-4/5 bg-ink-raised" />
      </div>
    {:else if document && body !== null}
      <ArticleView
        {document}
        {body}
        archived={documentQuery.data?.archived ?? false}
        supersededBy={documentQuery.data?.superseded_by ?? null}
        onSupersessorClick={(slug) => void goto(`/doc/wiki/${slug}.md`)}
        onLinkClick={handleLinkClick}
      />
    {:else}
      <div class="mx-auto max-w-[740px] px-4 pt-6 md:px-10 md:pt-10">
        <p class="text-[length:var(--text-body)] text-warm-faint">
          Document not found.
        </p>
      </div>
    {/if}
  </ArticleChrome>
</PanelHost>
