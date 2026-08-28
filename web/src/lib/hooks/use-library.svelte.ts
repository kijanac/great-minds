import { goto } from "$app/navigation";
import { page } from "$app/state";
import { createInfiniteQuery, createQuery, useQueryClient } from "@tanstack/svelte-query";
import { untrack } from "svelte";

import { nextPageOffset } from "$lib/api/schemas";
import {
  deleteSourceDocument,
  fetchSourceDocuments,
  requestSourceDeletion,
} from "$lib/api/sources";
import { getVaultDetail } from "$lib/api/vaults";
import { fetchWikiArticles } from "$lib/api/wiki";
import { activeVault } from "$lib/hooks/use-vault.svelte";
import { loadPanelContent } from "$lib/panel-content";
import type { SourceRef } from "$lib/types";

const PAGE_SIZE = 50;
export const LIBRARY_ALL = "all";
export const LIBRARY_ARTICLES = "articles";
export const LIBRARY_READING_ROOM = "reading-room";

export function useLibrary(
  selectedCard: () => SourceRef | null,
  onSourceDeleted: (sourceId: string) => void,
) {
  const queryClient = useQueryClient();
  let search = $state(page.url.searchParams.get("q") ?? "");
  let actionId = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let actionNotice = $state<string | null>(null);

  const activeType = $derived(page.url.searchParams.get("type") || LIBRARY_ALL);
  const activeTag = $derived(page.url.searchParams.get("tag") ?? "");
  const searchQuery = $derived(page.url.searchParams.get("q")?.trim() ?? "");
  const sourceType = $derived(
    activeType === LIBRARY_ALL ||
      activeType === LIBRARY_ARTICLES ||
      activeType === LIBRARY_READING_ROOM
      ? undefined
      : activeType,
  );

  $effect(() => {
    const urlSearch = page.url.searchParams.get("q") ?? "";
    if (urlSearch !== untrack(() => search.trim())) search = urlSearch;
  });

  $effect(() => {
    const value = search;
    const timeout = window.setTimeout(() => {
      const normalized = value.trim();
      if (normalized === (page.url.searchParams.get("q") ?? "")) return;
      const params = new URLSearchParams(page.url.searchParams);
      if (normalized) params.set("q", normalized);
      else params.delete("q");
      replaceLibraryUrl(params);
    }, 300);
    return () => window.clearTimeout(timeout);
  });

  const facets = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "library-facets", searchQuery, activeTag],
    queryFn: () =>
      fetchSourceDocuments({
        search: searchQuery || undefined,
        tag: activeTag || undefined,
        limit: 0,
      }),
    enabled: !!activeVault.id,
  }));

  const articles = createInfiniteQuery(() => ({
    queryKey: ["vault", activeVault.id, "library-articles", searchQuery, activeTag],
    queryFn: ({ pageParam }) =>
      fetchWikiArticles({
        contains: searchQuery || undefined,
        tag: activeTag || undefined,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => nextPageOffset(lastPage),
    enabled: !!activeVault.id,
  }));

  const sources = createInfiniteQuery(() => ({
    queryKey: [
      "vault",
      activeVault.id,
      "library-sources",
      sourceType ?? LIBRARY_ALL,
      searchQuery,
      activeTag,
    ],
    queryFn: ({ pageParam }) =>
      fetchSourceDocuments({
        source_type: sourceType,
        search: searchQuery || undefined,
        tag: activeTag || undefined,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => nextPageOffset(lastPage),
    enabled:
      !!activeVault.id && activeType !== LIBRARY_ARTICLES && activeType !== LIBRARY_READING_ROOM,
  }));

  const role = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "detail"],
    queryFn: () => getVaultDetail(activeVault.id!),
    enabled: !!activeVault.id,
  }));

  const panel = createQuery(() => ({
    queryKey: [
      "vault",
      activeVault.id,
      "article-panel",
      selectedCard()?.type,
      selectedCard()?.label,
      selectedCard()?.ranges,
      selectedCard()?.full,
    ],
    queryFn: ({ signal }) => loadPanelContent(selectedCard()!, "vault", signal),
    enabled: !!activeVault.id && !!selectedCard(),
  }));

  const sourceFacets = $derived(facets.data?.facets.source_types ?? []);
  const sourceTotal = $derived(sourceFacets.reduce((sum, facet) => sum + facet.count, 0));
  const articleTotal = $derived(articles.data?.pages[0]?.pagination.total ?? 0);
  // Header count reflects the current search/tag scope; the facet chips keep
  // whole-vault counts (the facets response ignores search — API behavior).
  const sourceListTotal = $derived(sources.data?.pages[0]?.pagination.total ?? sourceTotal);
  // Wiki pin: a wiki article whose title or slug matches the active tag
  // (case-insensitive), surfaced from the already-fetched articles as a
  // distinct synthesis row. Absence is normal.
  const pinArticle = $derived(
    activeTag === ""
      ? null
      : (articles.data?.pages
          .flatMap((result) => result.items)
          .find(
            (article) =>
              article.title.toLowerCase() === activeTag.toLowerCase() ||
              article.slug.toLowerCase() === activeTag.toLowerCase(),
          ) ?? null),
  );

  function replaceLibraryUrl(params: URLSearchParams) {
    const query = params.toString();
    void goto(`/library${query ? `?${query}` : ""}`, {
      replaceState: true,
      keepFocus: true,
      noScroll: true,
    });
  }

  function chooseType(value: string) {
    const params = new URLSearchParams(page.url.searchParams);
    if (!value || value === LIBRARY_ALL) params.delete("type");
    else params.set("type", value);
    replaceLibraryUrl(params);
  }

  function clearTag() {
    const params = new URLSearchParams(page.url.searchParams);
    params.delete("tag");
    replaceLibraryUrl(params);
  }

  async function refreshSources() {
    await queryClient.invalidateQueries({
      queryKey: ["vault", activeVault.id, "library-sources"],
    });
    await queryClient.invalidateQueries({
      queryKey: ["vault", activeVault.id, "library-facets"],
    });
  }

  async function deleteSource(sourceId: string) {
    actionId = sourceId;
    actionError = null;
    actionNotice = null;
    let deleted = false;
    try {
      await deleteSourceDocument(sourceId);
      deleted = true;
      onSourceDeleted(sourceId);
    } catch (error) {
      actionError = error instanceof Error ? error.message : "Failed to delete source";
      throw error;
    } finally {
      try {
        await refreshSources();
      } catch {
        if (deleted) {
          actionNotice = "Source deleted, but the library could not refresh. Reload to update it.";
        }
      }
      actionId = null;
    }
  }

  async function requestDeletion(sourceId: string) {
    actionId = sourceId;
    actionError = null;
    actionNotice = null;
    try {
      await requestSourceDeletion(sourceId);
      actionNotice = "Deletion request submitted.";
    } catch (error) {
      actionError = error instanceof Error ? error.message : "Failed to request source deletion";
      throw error;
    } finally {
      actionId = null;
    }
  }

  return {
    get actionError() {
      return actionError;
    },
    get actionNotice() {
      return actionNotice;
    },
    get actionId() {
      return actionId;
    },
    get activeType() {
      return activeType;
    },
    get activeTag() {
      return activeTag;
    },
    get articleItems() {
      return articles.data?.pages.flatMap((result) => result.items) ?? [];
    },
    get articleTotal() {
      return articleTotal;
    },
    articles,
    chooseType,
    clearTag,
    deleteSource,
    get headerCount() {
      return articleTotal + sourceListTotal;
    },
    get loading() {
      return articles.isLoading || sources.isLoading || facets.isLoading;
    },
    panel,
    get pinArticle() {
      return pinArticle;
    },
    requestDeletion,
    get role() {
      return role.data?.role ?? null;
    },
    get search() {
      return search;
    },
    setSearch(value: string) {
      search = value;
    },
    get sourceFacets() {
      return sourceFacets;
    },
    get sourceItems() {
      return sources.data?.pages.flatMap((result) => result.items) ?? [];
    },
    sources,
    get totalCount() {
      return articleTotal + sourceTotal;
    },
  };
}
