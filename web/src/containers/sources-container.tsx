import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { SourcesPage } from "@/components/sources-page";
import { useViewNavigate } from "@/hooks/use-view-navigate";
import { useLocalApp } from "@/local/app-provider";
import type { MemberRole } from "@/local/schema/member-role";
import type { SourceDocumentSummary, SourceTypeFacet } from "@/local/schema/source";
import { localApi } from "@/local/worker/client";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

export function SourcesContainer() {
  const navigate = useViewNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { workspace } = useLocalApp();

  const initialType = searchParams.get("type") || null;

  const [items, setItems] = useState<SourceDocumentSummary[]>([]);
  const [sourceTypes, setSourceTypes] = useState<SourceTypeFacet[]>([]);
  const [activeType, setActiveType] = useState<string | null>(initialType);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [role, setRole] = useState<MemberRole | null>(null);
  const [actionPath, setActionPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  useEffect(() => {
    let active = true;
    void localApi.getVaultSettings(workspace.vault.id).then(
      (settings) => {
        if (!active) return;
        const currentMember = settings.members.find(
          (member) => member.userId === workspace.user.id,
        );
        setRole(currentMember?.role ?? null);
      },
      () => {
        if (active) setRole(null);
      },
    );
    return () => {
      active = false;
    };
  }, [workspace.user.id, workspace.vault.id]);

  const load = useCallback(
    async (params: { sourceType?: string; search?: string; offset: number; append: boolean }) => {
      setLoading(true);
      try {
        const data = await localApi.listSources({
          sourceType: params.sourceType || undefined,
          search: params.search || undefined,
          limit: PAGE_SIZE,
          offset: params.offset,
        });
        setItems((prev) => (params.append ? [...prev, ...data.items] : data.items));
        if (!params.append) {
          setSourceTypes(data.facets.sourceTypes ?? []);
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
      sourceType: activeType ?? undefined,
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
        sourceType: activeType ?? undefined,
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
      sourceType: activeType ?? undefined,
      search,
      offset: newOffset,
      append: true,
    });
  }

  const handleDeleteSource = useCallback(
    async (filePath: string) => {
      setActionPath(filePath);
      setActionError(null);
      try {
        const deleted = await localApi.deleteSource({ filePath });
        if (!deleted) throw new Error("Source not found");

        setOffset(0);
        await load({
          sourceType: activeType ?? undefined,
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
        onDeleteSource: handleDeleteSource,
      }}
      onHome={() => navigate("/")}
      onSourceClick={(path) => navigate(`/doc/${path}`)}
      onTypeFilter={handleTypeFilter}
      onSearchChange={handleSearchChange}
      onLoadMore={handleLoadMore}
    />
  );
}
