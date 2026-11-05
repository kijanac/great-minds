<script lang="ts">
  import type { Uuid } from "@great-minds/domain";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";

  import LibraryContents from "$lib/components/library-contents.svelte";
  import ReadingRoomShelf from "$lib/components/reading-room-shelf.svelte";
  import VaultLibraryShelf from "$lib/components/vault-library-shelf.svelte";
  import type { ReferenceOverview } from "$lib/api/references";
  import { errorMessage } from "@great-minds/client";
  import {
    LIBRARY_READING_ROOM,
    LIBRARY_SOURCES,
    type LibraryView,
  } from "$lib/hooks/use-library.svelte";
  import type { ReadingRoomView } from "$lib/hooks/use-references.svelte";
  import type { SourceDocumentSummary, WikiArticleOverview } from "$lib/types";

  type LibraryActions = {
    chooseType: (value: string) => void;
    showAll: () => void;
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
    updatedSinceVisit,
  }: {
    library: LibraryView;
    readingRoom: ReadingRoomView;
    actions: LibraryActions;
    updatedSinceVisit: boolean;
  } = $props();

  const viewing = $derived(
    library.activeType === LIBRARY_READING_ROOM
      ? "reading room"
      : library.search
        ? `results for “${library.search.trim()}”`
        : library.activeTag
          ? `tagged “${library.activeTag}”`
          : library.activeType === LIBRARY_SOURCES
            ? "sources"
            : library.activeType,
  );
</script>

<main class="mx-auto max-w-[740px] px-4 pt-8 pb-24 md:px-10">
  {#if library.showContents}
    <LibraryContents
      articles={library.contents.data?.all ?? []}
      startHere={library.contents.data?.startHere ?? []}
      loading={library.contents.isLoading}
      error={library.contents.error
        ? errorMessage(library.contents.error, "The contents could not load.")
        : null}
      lastUpdated={library.lastUpdated}
      sourceTotal={library.sourceTotal}
      {updatedSinceVisit}
      canUpdate={library.canUpdate}
      updating={library.update.isPending}
      updateError={library.update.error
        ? errorMessage(library.update.error, "Couldn’t start an update.")
        : null}
      onOpen={actions.openArticle}
      onSources={() => actions.chooseType(LIBRARY_SOURCES)}
      onReadingRoom={() => actions.chooseType(LIBRARY_READING_ROOM)}
      onUpdate={() => library.update.mutate()}
    />
  {:else}
    <div class="mb-8 flex items-center gap-3">
      <button
        type="button"
        onclick={actions.showAll}
        class="inline-flex items-center gap-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted hover:text-gold"
      >
        <ArrowLeft size={12} aria-hidden="true" />
        contents
      </button>
      <span
        class="min-w-0 truncate font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost"
        >{viewing}</span
      >
    </div>

    {#if library.activeType === LIBRARY_READING_ROOM}
      <ReadingRoomShelf
        items={readingRoom.items}
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
  {/if}
</main>
