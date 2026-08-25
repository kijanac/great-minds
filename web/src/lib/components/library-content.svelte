<script lang="ts">
  import LibraryFilterChips from "$lib/components/library-filter-chips.svelte";
  import ReadingRoomShelf from "$lib/components/reading-room-shelf.svelte";
  import VaultLibraryShelf from "$lib/components/vault-library-shelf.svelte";
  import type { ReferenceOverview } from "$lib/api/references";
  import { LIBRARY_READING_ROOM } from "$lib/hooks/use-library.svelte";
  import type {
    SourceDocumentSummary,
    SourceTypeFacet,
    WikiArticleOverview,
  } from "$lib/types";

  type LibraryView = {
    activeType: string;
    activeTag: string;
    search: string;
    sourceFacets: SourceTypeFacet[];
    totalCount: number;
    articleTotal: number;
    articleItems: WikiArticleOverview[];
    pinArticle: WikiArticleOverview | null;
    sourceItems: SourceDocumentSummary[];
    loading: boolean;
    actionNotice: string | null;
    actionError: string | null;
    actionId: string | null;
    role: string | null;
    articles: {
      hasNextPage: boolean;
      isFetchingNextPage: boolean;
      fetchNextPage: () => Promise<unknown>;
    };
    sources: {
      hasNextPage: boolean;
      isFetchingNextPage: boolean;
      fetchNextPage: () => Promise<unknown>;
    };
  };

  type ReadingRoomView = {
    items: ReferenceOverview[];
    total: number;
    loading: boolean;
    error: string | null;
    creating: boolean;
    createError: string | null;
    references: {
      hasNextPage: boolean;
      isFetchingNextPage: boolean;
      fetchNextPage: () => Promise<unknown>;
    };
  };

  type LibraryActions = {
    chooseType: (value: string) => void;
    clearTag: () => void;
    openArticle: (article: WikiArticleOverview) => void;
    openSource: (source: SourceDocumentSummary) => void;
    openReference: (reference: ReferenceOverview) => void;
    openExternal: (url: string) => Promise<void>;
    deleteSource: (sourceId: string) => Promise<void>;
    requestDeletion: (sourceId: string) => Promise<void>;
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
