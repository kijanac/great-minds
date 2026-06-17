import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import {
  type SourceTypeFacet,
  type SourceDocumentSummary,
  deleteSourceDocument,
  fetchSourceDocuments,
  requestSourceDeletion,
} from "@/api/sources";
import { getVaultDetail } from "@/api/vaults";
import { SourcesPage } from "@/components/sources-page";
import { useViewNavigate } from "@/hooks/use-view-navigate";
import { useActiveVaultId } from "@/hooks/use-vault";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

export function SourcesContainer() {
  const navigate = useViewNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeVaultId = useActiveVaultId();

  const initialType = searchParams.get("type") || null;

  const [items, setItems] = useState<SourceDocumentSummary[]>([]);
  const [sourceTypes, setSourceTypes] = useState<SourceTypeFacet[]>([]);
  const [activeType, setActiveType] = useState<string | null>(initialType);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [role, setRole] = useState<string | null>(null);
  const [actionPath, setActionPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  useEffect(() => {
    if (!activeVaultId) {
      setRole(null);
      return;
    }

    let active = true;
    void getVaultDetail(activeVaultId).then(
      (detail) => {
        if (active) setRole(detail.role);
      },
      () => {
        if (active) setRole(null);
      },
    );
    return () => {
      active = false;
    };
  }, [activeVaultId]);

  const load = useCallback(
    async (params: { source_type?: string; search?: string; offset: number; append: boolean }) => {
      setLoading(true);
      try {
        const data = await fetchSourceDocuments({
          source_type: params.source_type || undefined,
          search: params.search || undefined,
          limit: PAGE_SIZE,
          offset: params.offset,
        });
        setItems((prev) => (params.append ? [...prev, ...data.items] : data.items));
        if (!params.append) {
          setSourceTypes(data.facets.source_types ?? []);
        }
        setHasMore(data.pagination.offset + data.items.length < data.pagination.total);
      } catch {
        if (!params.append) {
          setItems([]);
          setSourceTypes([]);
        }
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    setOffset(0);
    load({
      source_type: activeType ?? undefined,
      search: searchRef.current,
      offset: 0,
      append: false,
    });
  }, [activeType, load]);

  function handleTypeFilter(type: string | null) {
    setActiveType(type);
    if (type) {
      setSearchParams({ type });
    } else {
      setSearchParams({});
    }
  }

  function handleSearchChange(query: string) {
    setSearch(query);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setOffset(0);
      load({
        source_type: activeType ?? undefined,
        search: query,
        offset: 0,
        append: false,
      });
    }, SEARCH_DEBOUNCE_MS);
  }

  function handleLoadMore() {
    const newOffset = offset + PAGE_SIZE;
    setOffset(newOffset);
    load({
      source_type: activeType ?? undefined,
      search,
      offset: newOffset,
      append: true,
    });
  }

  const handleDeleteSource = useCallback(
    async (filePath: string) => {
      setActionPath(filePath);
      setActionError(null);
      setActionNotice(null);
      try {
        await deleteSourceDocument(filePath);
        setOffset(0);
        await load({
          source_type: activeType ?? undefined,
          search: searchRef.current,
          offset: 0,
          append: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete source";
        setActionError(message);
        throw error;
      } finally {
        setActionPath(null);
      }
    },
    [activeType, load],
  );

  const handleRequestDeletion = useCallback(async (filePath: string) => {
    setActionPath(filePath);
    setActionError(null);
    setActionNotice(null);
    try {
      await requestSourceDeletion(filePath);
      setActionNotice("Deletion request submitted.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to request source deletion";
      setActionError(message);
      throw error;
    } finally {
      setActionPath(null);
    }
  }, []);

  return (
    <SourcesPage
      items={items}
      sourceTypes={sourceTypes}
      activeType={activeType}
      search={search}
      loading={loading}
      hasMore={hasMore}
      sourceActions={{
        role,
        busyPath: actionPath,
        error: actionError,
        notice: actionNotice,
        onDeleteSource: handleDeleteSource,
        onRequestDeletion: handleRequestDeletion,
      }}
      onHome={() => navigate("/")}
      onSourceClick={(path) => navigate(`/doc/${path}`)}
      onTypeFilter={handleTypeFilter}
      onSearchChange={handleSearchChange}
      onLoadMore={handleLoadMore}
    />
  );
}
