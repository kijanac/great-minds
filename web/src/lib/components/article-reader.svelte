<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Uuid } from "@great-minds/domain";
  import { onDestroy, tick, untrack } from "svelte";

  import type { DocumentScope } from "$lib/api/doc";
  import {
    postUserSuggestion,
    type UserSuggestionResult,
  } from "$lib/api/ingest";
  import { auth } from "$lib/auth.svelte";
  import { DocThreads } from "$lib/doc-threads.svelte";
  import ArticleChrome from "$lib/components/article-chrome.svelte";
  import ArticlePanel from "$lib/components/article-panel.svelte";
  import ArticleView from "$lib/components/article-view.svelte";
  import OnboardingHint, {
    dismissOnboardingHint,
    onboardingHintSeen,
  } from "$lib/components/onboarding-hint.svelte";
  import PanelHost from "$lib/components/panel-host.svelte";
  import SelectionPopover from "$lib/components/selection-popover.svelte";
  import SuggestionForm, {
    type SuggestionPayload,
  } from "$lib/components/suggestion-form.svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { useReferencePromotion } from "$lib/hooks/use-reference-promotion.svelte";
  import {
    activeVault,
    useVaultDetail,
    useVaults,
  } from "$lib/hooks/use-vault.svelte";
  import {
    useArticleLinks,
    useDocument,
    usePersonalDocument,
    useSourceDocument,
  } from "$lib/hooks/use-document.svelte";
  import { usePanelCard } from "$lib/hooks/use-panel-card.svelte";
  import { usePanelContent } from "$lib/hooks/use-panel-content.svelte";
  import type { SelectionInfo } from "$lib/types";
  import { displayTitle } from "$lib/utils";

  let {
    path = null,
    sourceId = null,
    scope,
  }: {
    path?: string | null;
    sourceId?: Uuid | null;
    scope: DocumentScope;
  } = $props();

  let popover = $state<SelectionInfo | null>(null);
  let suggestionTarget = $state<SelectionInfo | null>(null);
  const initialPath = untrack(() => path);
  const initialSourceId = untrack(() => sourceId);
  const readerScope = untrack(() => scope);
  const card = usePanelCard(readerScope);
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
  const vaultDetail = useVaultDetail(
    () => activeVault.id,
    () => wikiSlug !== null,
  );
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
  const showHint = $derived(!onboardingHintSeen() && body !== null);
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

  const panelQuery = usePanelContent(() => card.selectedCard, readerScope);

  let focusedThread: string | null = null;
  $effect(() => {
    const target = page.url.searchParams.get("thread");
    const threads = docThreads;
    if (
      !target ||
      body === null ||
      !threads ||
      threads.loading ||
      focusedThread === target
    )
      return;
    const thread = threads.threads.find(
      (item) => item.conversation?.id === target,
    );
    if (!thread) return;
    focusedThread = target;
    void tick().then(() => threads.jumpTo(thread.id));
  });

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

  function startBtw() {
    if (!popover || !docThreads) return;
    docThreads.startThread(popover);
    dismissOnboardingHint();
    popover = null;
    window.getSelection()?.removeAllRanges();
  }

  function startSuggestion() {
    if (!popover || !suggestionMode) return;
    suggestionTarget = popover;
    dismissOnboardingHint();
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

  async function promotePersonalReference() {
    if (!activeVault.id) return;
    try {
      const promoted = await promotion.promote(activeVault.id, resolvedPath);
      await goto(`/source/${promoted.id}`);
    } catch {
      return;
    }
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

<PanelHost open={!!card.selectedCard} onClose={card.close}>
  {#snippet panel()}
    {#if card.selectedCard}
      <ArticlePanel
        card={card.selectedCard}
        content={panelQuery.data ?? null}
        loading={panelQuery.isLoading}
        context="citation"
        onClose={card.close}
        onFullScreen={card.maximize}
        onOpenPath={card.openPath}
        onLinkClick={card.onLinkClick}
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
        <OnboardingHint>
          highlight text to ask beside the passage with
          <span class="text-btw">btw</span
          >{#if suggestionMode}{", or suggest a change"}{/if}
        </OnboardingHint>
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
        onLinkClick={card.onLinkClick}
        panelDocked={!!card.selectedCard}
        threads={docThreads.threads}
        jumpableThreads={docThreads.jumpable}
        expandedThreads={docThreads.expanded}
        onToggleThread={docThreads.toggleExpanded}
        onOpenSession={docThreads.openSession}
        onThreadJump={docThreads.jumpTo}
        documentId={document.id}
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
        onDismiss={() => (popover = null)}
        onBtw={startBtw}
        onSuggest={suggestionMode ? startSuggestion : undefined}
      />
    {/if}
  </ArticleChrome>
</PanelHost>
