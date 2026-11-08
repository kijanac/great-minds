import { goto } from "$app/navigation";
import { page } from "$app/state";
import type { Uuid } from "@great-minds/domain";
import {
  createInfiniteQuery,
  createMutation,
  createQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/svelte-query";
import { untrack } from "svelte";

import { errorMessage } from "@great-minds/client";
import { nextPageOffset } from "@great-minds/client";
import {
  deleteSourceDocument,
  fetchSourceDocuments,
  requestSourceDeletion,
} from "#lib/api/sources.ts";
import { requestCompile } from "#lib/api/jobs.ts";
import { fetchAllWikiArticles, fetchWikiArticles } from "#lib/api/wiki.ts";
import { usePanelContent } from "#lib/hooks/use-panel-content.svelte.ts";
import { activeVault, useVaultDetail } from "#lib/hooks/use-vault.svelte.ts";
import type { SourceRef } from "#lib/types.ts";

const PAGE_SIZE = 50;
export const LIBRARY_ALL = "all";
export const LIBRARY_ARTICLES = "articles";
export const LIBRARY_SOURCES = "sources";
export const LIBRARY_READING_ROOM = "reading-room";
const START_HERE = 8;

export function invalidateSourceLists(queryClient: QueryClient, vaultId: Uuid | null) {
  return Promise.all(
    ["library-sources", "library-facets"].map((list) =>
      queryClient.invalidateQueries({ queryKey: ["vault", vaultId, list] }),
    ),
  );
}

export function useLibrary(
  selectedCard: () => SourceRef | null,
  onSourceDeleted: (sourceId: Uuid) => void,
) {
  const queryClient = useQueryClient();
  let search = $state(page.url.searchParams.get("q") ?? "");
  let actionId = $state<Uuid | null>(null);
  let actionError = $state<string | null>(null);
  let actionNotice = $state<string | null>(null);

  const activeType = $derived(page.url.searchParams.get("type") || LIBRARY_ALL);
  const activeTag = $derived(page.url.searchParams.get("tag") ?? "");
  const searchQuery = $derived(page.url.searchParams.get("q")?.trim() ?? "");
  const sourceType = $derived(
    activeType === LIBRARY_ALL ||
      activeType === LIBRARY_ARTICLES ||
      activeType === LIBRARY_SOURCES ||
      activeType === LIBRARY_READING_ROOM
      ? undefined
      : activeType,
  );
  const showContents = $derived(
    activeType === LIBRARY_ALL && activeTag === "" && searchQuery === "",
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
      const params = new URLSearchParams(page.url.search);
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

  const contents = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "library-contents"],
    queryFn: async () => {
      const [all, linked] = await Promise.all([
        fetchAllWikiArticles(),
        fetchWikiArticles({ sort: "linked", limit: START_HERE }),
      ]);
      return { all, startHere: linked.items };
    },
    enabled: !!activeVault.id && showContents,
  }));

  const update = createMutation(() => ({
    mutationFn: () => requestCompile(),
    onSuccess: async (job) => {
      await queryClient.invalidateQueries({
        queryKey: ["vault", activeVault.id, "active-job"],
      });
      await goto(`/pipeline/runs/${job.id}`);
    },
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
    enabled: !!activeVault.id && !showContents && activeType !== LIBRARY_SOURCES,
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
      !!activeVault.id &&
      !showContents &&
      activeType !== LIBRARY_ARTICLES &&
      activeType !== LIBRARY_READING_ROOM,
  }));

  const role = useVaultDetail(() => activeVault.id);

  const panel = usePanelContent(selectedCard);

  const sourceTotal = $derived(facets.data?.pagination.total ?? 0);
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
      replace: true,
      reset: false,
    });
  }

  function showAll() {
    replaceLibraryUrl(new URLSearchParams());
  }

  function chooseType(value: string) {
    const params = new URLSearchParams(page.url.search);
    if (!value || value === LIBRARY_ALL) params.delete("type");
    else params.set("type", value);
    replaceLibraryUrl(params);
  }

  async function deleteSource(sourceId: Uuid) {
    actionId = sourceId;
    actionError = null;
    actionNotice = null;
    let deleted = false;
    try {
      await deleteSourceDocument(sourceId);
      deleted = true;
      onSourceDeleted(sourceId);
    } catch (error) {
      actionError = errorMessage(error, "Failed to delete source");
      throw error;
    } finally {
      try {
        await invalidateSourceLists(queryClient, activeVault.id);
      } catch {
        if (deleted) {
          actionNotice = "Source deleted, but the library could not refresh. Reload to update it.";
        }
      }
      actionId = null;
    }
  }

  async function requestDeletion(sourceId: Uuid) {
    actionId = sourceId;
    actionError = null;
    actionNotice = null;
    try {
      await requestSourceDeletion(sourceId);
      actionNotice = "Deletion request submitted.";
    } catch (error) {
      actionError = errorMessage(error, "Failed to request source deletion");
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
    articles,
    chooseType,
    contents,
    deleteSource,
    get canUpdate() {
      return role.data?.role === "owner";
    },
    get lastUpdated() {
      const times = (contents.data?.all ?? []).flatMap((article) =>
        article.updated_at === null ? [] : [article.updated_at.getTime()],
      );
      return times.length === 0 ? null : new Date(Math.max(...times));
    },
    get loading() {
      return articles.isLoading || sources.isLoading || facets.isLoading;
    },
    panel,
    get pinArticle() {
      return pinArticle;
    },
    requestDeletion,
    showAll,
    get showContents() {
      return showContents;
    },
    get sourceTotal() {
      return sourceTotal;
    },
    update,
    get role() {
      return role.data?.role ?? null;
    },
    get search() {
      return search;
    },
    setSearch(value: string) {
      search = value;
    },
    get sourceItems() {
      return sources.data?.pages.flatMap((result) => result.items) ?? [];
    },
    sources,
  };
}

export type LibraryView = ReturnType<typeof useLibrary>;
