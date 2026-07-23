<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { createQuery } from "@tanstack/svelte-query";
  import { onDestroy, tick, untrack } from "svelte";

  import { EphemeralBtws } from "$lib/btw.svelte";
  import ArticleChrome from "$lib/components/article-chrome.svelte";
  import ArticlePanel from "$lib/components/article-panel.svelte";
  import ArticleView from "$lib/components/article-view.svelte";
  import PanelHost from "$lib/components/panel-host.svelte";
  import SelectionPopover from "$lib/components/selection-popover.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { activeVault } from "$lib/hooks/use-vault.svelte";
  import { useDocument } from "$lib/hooks/use-document.svelte";
  import {
    createLinkInterceptor,
    type RawCitation,
  } from "$lib/hooks/use-link-interceptor";
  import { loadPanelContent } from "$lib/panel-content";
  import type { SelectionInfo, SourceRef } from "$lib/types";
  import { displayTitle } from "$lib/utils";

  let { path }: { path: string } = $props();

  let selectedCard = $state<SourceRef | null>(null);
  let popover = $state<SelectionInfo | null>(null);
  let hintDismissed = $state(
    localStorage.getItem("onboarding-hint-seen") === "true",
  );
  const initialPath = untrack(() => path);
  let btwPath = initialPath;
  let ephemeralBtws = $state(
    new EphemeralBtws(initialPath, (id) => void goto(`/sessions/${id}`)),
  );
  const documentQuery = useDocument(() => path);
  const document = $derived(documentQuery.data?.article ?? null);
  const body = $derived(documentQuery.data?.body ?? null);
  const label = $derived(displayTitle(path, document?.title));
  const showHint = $derived(!hintDismissed && body !== null);

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

  onDestroy(() => ephemeralBtws.destroy());

  $effect(() => {
    if (path === btwPath) return;
    ephemeralBtws.destroy();
    btwPath = path;
    ephemeralBtws = new EphemeralBtws(
      path,
      (id) => void goto(`/sessions/${id}`),
    );
    popover = null;
  });

  $effect(() => {
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Node | null;
      const element = window.document.querySelector("[data-popover]");
      if (target && element?.contains(target)) return;
      popover = null;
    };
    const scroll = () => (popover = null);
    window.document.addEventListener("mousedown", dismiss);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.document.removeEventListener("mousedown", dismiss);
      window.removeEventListener("scroll", scroll, true);
    };
  });

  function startBtw() {
    if (!popover) return;
    ephemeralBtws.startBtw(popover);
    popover = null;
    window.getSelection()?.removeAllRanges();
  }

  function dismissHint() {
    hintDismissed = true;
    localStorage.setItem("onboarding-hint-seen", "true");
  }

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
    {#snippet footer()}
      {#if showHint}
        <div
          class="shrink-0 animate-[slide-up_0.28s_ease] border-t border-ink-subtle px-4 py-3 md:px-10"
        >
          <div
            class="mx-auto flex max-w-[740px] items-center justify-between gap-4"
          >
            <p
              class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint"
            >
              <Badge
                variant="outline"
                class="mr-2 border-gold-dim font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted"
              >
                tip
              </Badge>
              highlight any text to start a
              <span class="text-btw">btw</span> thread
            </p>
            <Button
              variant="ghost"
              size="sm"
              onclick={dismissHint}
              class="h-auto shrink-0 px-2 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost hover:bg-transparent hover:text-warm-faint"
            >
              dismiss
            </Button>
          </div>
        </div>
      {/if}
    {/snippet}

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
        panelDocked={!!selectedCard}
        btws={ephemeralBtws.btws}
        documentId={path}
        onSelection={(info) => (popover = info)}
        onBtwReply={ephemeralBtws.replyBtw}
        onBtwDismiss={ephemeralBtws.dismissEmpty}
        onBtwSpinOff={(id) => void ephemeralBtws.spinOff(id)}
      />
    {:else}
      <div class="mx-auto max-w-[740px] px-4 pt-6 md:px-10 md:pt-10">
        <p class="text-[length:var(--text-body)] text-warm-faint">
          Document not found.
        </p>
      </div>
    {/if}

    {#if popover}
      <SelectionPopover info={popover} onBtw={startBtw} />
    {/if}
  </ArticleChrome>
</PanelHost>
