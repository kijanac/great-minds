<script lang="ts">
  import { goto } from "$app/navigation";
  import Search from "@lucide/svelte/icons/search";

  import ArticlePanel from "#lib/components/article-panel.svelte";
  import LibraryContent from "#lib/components/library-content.svelte";
  import PageHeader from "#lib/components/page-header.svelte";
  import PanelHost from "#lib/components/panel-host.svelte";
  import { Input } from "#lib/components/ui/input/index.ts";
  import type { ReferenceOverview } from "#lib/api/references.ts";
  import { LIBRARY_READING_ROOM, useLibrary } from "#lib/hooks/use-library.svelte.ts";
  import { usePanelCard } from "#lib/hooks/use-panel-card.svelte.ts";
  import { useReferences } from "#lib/hooks/use-references.svelte.ts";
  import { activeVault } from "#lib/hooks/use-vault.svelte.ts";

  const card = usePanelCard();
  const library = useLibrary(
    () => card.selectedCard,
    (sourceId) => {
      if (card.selectedCard?.document_id === sourceId) card.close();
    },
  );
  const readingRoom = useReferences();

  let updatedSinceVisit = $state(false);
  let checkedVault: string | null = null;
  $effect(() => {
    const vaultId = activeVault.id;
    const updated = library.lastUpdated;
    if (!vaultId || !updated || checkedVault === vaultId) return;
    checkedVault = vaultId;
    const key = `library-seen:${vaultId}`;
    const seen = Number(localStorage.getItem(key) ?? "0");
    updatedSinceVisit = seen > 0 && updated.getTime() > seen;
    localStorage.setItem(key, String(updated.getTime()));
  });

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
    showAll: library.showAll,
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
        context="citation"
        onClose={card.close}
        onFullScreen={card.maximize}
        onOpenPath={card.openPath}
        onLinkClick={card.onLinkClick}
      />
    {/if}
  {/snippet}

  <div class="flex h-dvh flex-col overflow-hidden">
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
    <PageHeader title="library" trailing={search} onHome={() => void goto("/")} />

    <div class="min-h-0 flex-1 overflow-y-auto">
      <LibraryContent {library} {readingRoom} {actions} {updatedSinceVisit} />
    </div>
  </div>
</PanelHost>
