<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { createQuery } from "@tanstack/svelte-query";
  import { onDestroy, tick, untrack } from "svelte";

  import type { DocumentScope } from "$lib/api/doc";
  import {
    postUserSuggestion,
    type UserSuggestionResult,
  } from "$lib/api/ingest";
  import { getVaultDetail } from "$lib/api/vaults";
  import { auth } from "$lib/auth.svelte";
  import { DocThreads } from "$lib/btw.svelte";
  import ArticleChrome from "$lib/components/article-chrome.svelte";
  import ArticlePanel from "$lib/components/article-panel.svelte";
  import ArticleView from "$lib/components/article-view.svelte";
  import PanelHost from "$lib/components/panel-host.svelte";
  import SelectionPopover from "$lib/components/selection-popover.svelte";
  import SuggestionForm, {
    type SuggestionPayload,
  } from "$lib/components/suggestion-form.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { useReferencePromotion } from "$lib/hooks/use-reference-promotion.svelte";
  import { activeVault, useVaults } from "$lib/hooks/use-vault.svelte";
  import {
    useArticleLinks,
    useDocument,
    usePersonalDocument,
    useSourceDocument,
  } from "$lib/hooks/use-document.svelte";
  import {
    createLinkInterceptor,
    type RawCitation,
  } from "$lib/hooks/use-link-interceptor";
  import { usePanelContent } from "$lib/hooks/use-panel-content.svelte";
  import type { SelectionInfo, SourceRef } from "$lib/types";
  import { displayTitle } from "$lib/utils";

  let {
    path = null,
    sourceId = null,
    scope,
  }: {
    path?: string | null;
    sourceId?: string | null;
    scope: DocumentScope;
  } = $props();

  let selectedCard = $state<SourceRef | null>(null);
  let popover = $state<SelectionInfo | null>(null);
  let suggestionTarget = $state<SelectionInfo | null>(null);
  let hintDismissed = $state(
    localStorage.getItem("onboarding-hint-seen") === "true",
  );
  const initialPath = untrack(() => path);
  const initialSourceId = untrack(() => sourceId);
  const readerScope = untrack(() => scope);
  let btwPath: string | null = initialPath;
  let docThreads = $state<DocThreads | null>(
    initialPath === null
      ? null
      : new DocThreads(
          initialPath,
          readerScope,
          (id) => void goto(`/sessions/${id}`),
        ),
  );
  const documentQuery =
    initialSourceId !== null
      ? useSourceDocument(() => initialSourceId)
      : readerScope === "personal"
        ? usePersonalDocument(() => path)
        : useDocument(() => path);
  const vaults = useVaults();
  const promotion = useReferencePromotion();
  const document = $derived(documentQuery.data?.article ?? null);
  const body = $derived(documentQuery.data?.body ?? null);
  const resolvedPath = $derived(document?.file_path ?? path ?? "");
  const label = $derived(displayTitle(resolvedPath, document?.title));
  const wikiSlug = $derived(
    readerScope === "vault" &&
      resolvedPath.startsWith("wiki/") &&
      resolvedPath.endsWith(".md")
      ? resolvedPath.slice("wiki/".length, -".md".length)
      : null,
  );
  const vaultDetail = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "detail"],
    queryFn: () => getVaultDetail(activeVault.id!),
    enabled: wikiSlug !== null && !!activeVault.id,
  }));
  const suggestionMode = $derived<UserSuggestionResult["mode"] | null>(
    vaultDetail.data?.role === "owner"
      ? "ingested"
      : vaultDetail.data?.role === "editor"
        ? "proposed"
        : null,
  );
  const articleLinks = useArticleLinks(() =>
    readerScope === "vault" && resolvedPath.startsWith("wiki/")
      ? resolvedPath
      : null,
  );
  const showHint = $derived(!hintDismissed && body !== null);
  const selectedVault = $derived(
    vaults.data?.find((vault) => vault.id === activeVault.id) ?? null,
  );
  const promotionAction = $derived(
    readerScope === "personal" && selectedVault?.owner_id === auth.userId
      ? {
          vaultName: selectedVault.name,
          pending: promotion.pending,
          error: promotion.error,
          onPromote: promotePersonalReference,
        }
      : null,
  );

  const panelQuery = usePanelContent(() => selectedCard, readerScope);

  function openRawCitation(citation: RawCitation) {
    selectedCard = {
      type: "raw",
      label: citation.path,
      document_id: null,
      title: null,
      scope: null,
      path: null,
      thinking: null,
      ranges:
        citation.chunk == null
          ? undefined
          : [{ start: citation.chunk, end: citation.chunk }],
      full: readerScope === "personal" || citation.chunk == null,
    };
  }

  const handleLinkClick = createLinkInterceptor(openRawCitation);

  onDestroy(() => docThreads?.destroy());

  $effect(() => {
    // The body just (re)mounted: re-check which thread anchors resolve to a
    // rendered block so the header panel can drop the jump affordance for
    // unresolvable ones.
    if (body === null) return;
    void tick().then(() => {
      requestAnimationFrame(() => docThreads?.refreshJumpable());
    });
  });

  $effect(() => {
    const currentPath = resolvedPath;
    if (currentPath === "" || currentPath === btwPath) return;
    docThreads?.destroy();
    btwPath = currentPath;
    docThreads = new DocThreads(
      currentPath,
      readerScope,
      (id) => void goto(`/sessions/${id}`),
    );
    popover = null;
    suggestionTarget = null;
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
    if (!popover || !docThreads) return;
    docThreads.startThread(popover);
    popover = null;
    window.getSelection()?.removeAllRanges();
  }

  function startSuggestion() {
    if (!popover || !suggestionMode) return;
    suggestionTarget = popover;
    popover = null;
    window.getSelection()?.removeAllRanges();
  }

  async function submitSuggestion(
    payload: SuggestionPayload,
  ): Promise<UserSuggestionResult["mode"]> {
    const target = suggestionTarget;
    const anchor = wikiSlug;
    if (!target || !anchor) {
      throw new Error(
        "This suggestion is no longer attached to an article passage.",
      );
    }
    const result = await postUserSuggestion({
      ...payload,
      anchoredTo: anchor,
      anchoredSection: target.quote,
    });
    return result.mode;
  }

  function dismissHint() {
    hintDismissed = true;
    localStorage.setItem("onboarding-hint-seen", "true");
  }

  async function promotePersonalReference() {
    if (!activeVault.id) return;
    try {
      const promoted = await promotion.promote(activeVault.id, resolvedPath);
      await goto(`/source/${promoted.id}`);
    } catch {
      return;
    }
  }

  function openPanelPath(linkedPath: string) {
    if (readerScope === "personal") {
      selectedCard = null;
      void goto(`/refs/${linkedPath}`);
      return;
    }
    if (linkedPath.startsWith("wiki/")) {
      selectedCard = null;
      void goto(`/doc/${linkedPath}`);
      return;
    }
    selectedCard = {
      type: "raw",
      label: linkedPath,
      document_id: null,
      title: null,
      scope: null,
      path: null,
      thinking: null,
      full: true,
    };
  }

  async function maximizePanel() {
    const card = selectedCard;
    if (!card) return;
    const range = card.ranges?.length === 1 ? card.ranges[0] : null;
    const hash = range && range.start === range.end ? `#^p${range.start}` : "";
    selectedCard = null;
    await goto(
      readerScope === "vault" && card.type === "raw" && card.document_id
        ? `/source/${card.document_id}${hash}`
        : `${readerScope === "personal" ? "/refs/" : "/doc/"}${card.label}${hash}`,
    );
  }

  $effect(() => {
    const hash = page.url.hash;
    const renderedBody = body;
    const currentPath = resolvedPath;
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
        `/?q=${encodeURIComponent(question)}&origin=${encodeURIComponent(resolvedPath)}`,
      )}
  >
    {#snippet footer()}
      {#if suggestionTarget && suggestionMode}
        <SuggestionForm
          articleLabel={label}
          anchoredSection={suggestionTarget.quote}
          expectedMode={suggestionMode}
          onSubmit={submitSuggestion}
          onClose={() => (suggestionTarget = null)}
        />
      {:else if showHint}
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
              <span class="text-btw">btw</span>
              thread{#if suggestionMode}{" or suggest a change"}{/if}
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
    {:else if document && body !== null && docThreads}
      <ArticleView
        {document}
        scope={readerScope}
        {promotionAction}
        {body}
        archived={documentQuery.data?.archived ?? false}
        supersededBy={documentQuery.data?.superseded_by ?? null}
        onSupersessorClick={(slug) => void goto(`/doc/wiki/${slug}.md`)}
        related={articleLinks.data?.related ?? []}
        onRelatedClick={(filePath) => void goto(`/doc/${filePath}`)}
        onLinkClick={handleLinkClick}
        panelDocked={!!selectedCard}
        threads={docThreads.threads}
        jumpableThreads={docThreads.jumpable}
        expandedThreads={docThreads.expanded}
        onToggleThread={docThreads.toggleExpanded}
        onOpenSession={docThreads.openSession}
        onThreadJump={docThreads.jumpTo}
        documentId={resolvedPath}
        onSelection={(info) => (popover = info)}
        onBtwReply={docThreads.replyThread}
        onBtwRetry={docThreads.retryThread}
        onBtwDismiss={docThreads.dismissEmpty}
      />
    {:else}
      <div class="mx-auto max-w-[740px] px-4 pt-6 md:px-10 md:pt-10">
        <p class="text-[length:var(--text-body)] text-warm-faint">
          Document not found.
        </p>
      </div>
    {/if}

    {#if popover}
      <SelectionPopover
        info={popover}
        onBtw={startBtw}
        onSuggest={suggestionMode ? startSuggestion : undefined}
      />
    {/if}
  </ArticleChrome>
</PanelHost>
