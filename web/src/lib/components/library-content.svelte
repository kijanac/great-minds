<script lang="ts">
  import type { Uuid } from "@great-minds/domain";

  import LibraryFilterChips from "$lib/components/library-filter-chips.svelte";
  import ReadingRoomShelf from "$lib/components/reading-room-shelf.svelte";
  import VaultLibraryShelf from "$lib/components/vault-library-shelf.svelte";
  import type { ReferenceOverview } from "$lib/api/references";
  import {
    LIBRARY_READING_ROOM,
    type LibraryView,
  } from "$lib/hooks/use-library.svelte";
  import type { ReadingRoomView } from "$lib/hooks/use-references.svelte";
  import type { SourceDocumentSummary, WikiArticleOverview } from "$lib/types";

  type LibraryActions = {
    chooseType: (value: string) => void;
    clearTag: () => void;
    openArticle: (article: WikiArticleOverview) => void;
    openSource: (source: SourceDocumentSummary) => void;
    openReference: (reference: ReferenceOverview) => void;
    openExternal: (url: string) => Promise<void>;
    deleteSource: (sourceId: Uuid) => Promise<void>;
    requestDeletion: (sourceId: Uuid) => Promise<void>;
  };

  let {
    library,
    readingRoom,
    actions,
  }: {
    library: LibraryView;
    readingRoom: ReadingRoomView;
    actions: LibraryActions;
  } = $props();
  // Reading-room references carry no tags: under an active tag the shelf is
  // empty and the type chip count reflects that.
  const tagActive = $derived(!!library.activeTag);
  const readingRoomTotal = $derived(tagActive ? 0 : readingRoom.total);
</script>

<main class="mx-auto max-w-[740px] px-4 pt-8 pb-20 md:px-10">
  <LibraryFilterChips
    activeType={library.activeType}
    activeTag={library.activeTag}
    totalCount={library.totalCount}
    articleTotal={library.articleTotal}
    sourceFacets={library.sourceFacets}
    showCounts={library.showCounts}
    {readingRoomTotal}
    onChange={actions.chooseType}
    onClearTag={actions.clearTag}
  />

  {#if library.activeType === LIBRARY_READING_ROOM}
    <ReadingRoomShelf
      items={tagActive ? [] : readingRoom.items}
      loading={readingRoom.loading}
      error={readingRoom.error}
      creating={readingRoom.creating}
      createError={readingRoom.createError}
      hasNextPage={readingRoom.references.hasNextPage}
      fetchingNextPage={readingRoom.references.isFetchingNextPage}
      onLoadMore={readingRoom.references.fetchNextPage}
      onOpen={actions.openReference}
      onOpenExternal={actions.openExternal}
    />
  {:else}
    <VaultLibraryShelf
      {library}
      onOpenArticle={actions.openArticle}
      onOpenSource={actions.openSource}
      onDeleteSource={actions.deleteSource}
      onRequestDeletion={actions.requestDeletion}
    />
  {/if}
</main>
