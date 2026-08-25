<script lang="ts">
  import { goto } from "$app/navigation";
  import Search from "@lucide/svelte/icons/search";

  import ArticlePanel from "$lib/components/article-panel.svelte";
  import HealthIndicator from "$lib/components/health-indicator.svelte";
  import LibraryContent from "$lib/components/library-content.svelte";
  import PageHeader from "$lib/components/page-header.svelte";
  import PanelHost from "$lib/components/panel-host.svelte";
  import { Input } from "$lib/components/ui/input";
  import type { ReferenceOverview } from "$lib/api/references";
  import { useHealthReport } from "$lib/hooks/use-health-report.svelte";
  import {
    LIBRARY_READING_ROOM,
    useLibrary,
  } from "$lib/hooks/use-library.svelte";
  import { usePanelCard } from "$lib/hooks/use-panel-card.svelte";
  import { useReferences } from "$lib/hooks/use-references.svelte";

  const card = usePanelCard();
  const library = useLibrary(
    () => card.selectedCard,
    (path) => {
      if (card.selectedCard?.label === path) card.close();
    },
  );
  const readingRoom = useReferences();
  const health = useHealthReport();
  const headerCount = $derived(
    library.activeType === LIBRARY_READING_ROOM
      ? library.activeTag
        ? 0
        : readingRoom.total
      : library.headerCount,
  );

  function openReference(reference: ReferenceOverview) {
    void goto(`/refs/${reference.file_path}`);
  }

  async function openExternal(url: string) {
    try {
      const reference = await readingRoom.create(url);
      await goto(`/refs/${reference.file_path}`);
    } catch {
      return;
    }
  }

  const actions = {
    chooseType: library.chooseType,
    clearTag: library.clearTag,
    openArticle: card.openArticle,
    openSource: card.openSource,
    openReference,
    openExternal,
    deleteSource: library.deleteSource,
    requestDeletion: library.requestDeletion,
  };
</script>

<svelte:head>
  <title>Library | Great Minds</title>
</svelte:head>

<PanelHost open={!!card.selectedCard} onClose={card.close}>
  {#snippet panel()}
    {#if card.selectedCard}
      <ArticlePanel
        card={card.selectedCard}
        content={library.panel.data ?? null}
        loading={library.panel.isLoading}
        onClose={card.close}
        onFullScreen={() => void goto(`/doc/${card.selectedCard?.label}`)}
        onOpenPath={card.openPath}
      />
    {/if}
  {/snippet}

  <div class="flex h-screen flex-col overflow-hidden">
    {#snippet detail()}
      {#if headerCount > 0}
        <span
          class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
        >
          {headerCount}
        </span>
      {/if}
      <HealthIndicator
        status={health.status}
        count={health.count}
        onOpen={() => void goto("/health")}
      />
    {/snippet}
    {#snippet search()}
      {#if library.activeType !== LIBRARY_READING_ROOM}
        <div class="flex w-full max-w-[300px] items-center gap-2">
          <Search size={14} class="shrink-0 text-muted-foreground" />
          <Input
            value={library.search}
            oninput={(event) => library.setSearch(event.currentTarget.value)}
            class="h-7 rounded-sm border-ink-border bg-transparent px-3 font-serif text-[length:var(--text-small)] text-foreground caret-gold placeholder:text-input focus-visible:border-gold-dim focus-visible:ring-0 dark:bg-transparent"
            placeholder="Search library..."
          />
        </div>
      {/if}
    {/snippet}
    <PageHeader
      title="library"
      {detail}
      trailing={search}
      onHome={() => void goto("/")}
    />

    <div class="min-h-0 flex-1 overflow-y-auto">
      <LibraryContent {library} {readingRoom} {actions} />
    </div>
  </div>
</PanelHost>
