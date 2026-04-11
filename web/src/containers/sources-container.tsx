import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import {
  type ContentTypeCount,
  type RawSourceItem,
  fetchRawSources,
} from "@/api/sources";
import { SourcesPage } from "@/components/sources-page";
import { useViewNavigate } from "@/hooks/use-view-navigate";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

export function SourcesContainer() {
  const navigate = useViewNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialType = searchParams.get("type") || null;

  const [items, setItems] = useState<RawSourceItem[]>([]);
  const [contentTypes, setContentTypes] = useState<ContentTypeCount[]>([]);
  const [activeType, setActiveType] = useState<string | null>(initialType);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  const load = useCallback(
    async (params: {
      content_type?: string;
      search?: string;
      offset: number;
      append: boolean;
    }) => {
      setLoading(true);
      try {
        const data = await fetchRawSources({
          content_type: params.content_type || undefined,
          search: params.search || undefined,
          limit: PAGE_SIZE,
          offset: params.offset,
        });
        setItems((prev) =>
          params.append ? [...prev, ...data.items] : data.items,
        );
        if (!params.append) {
          setContentTypes(data.content_types);
        }
        setHasMore(data.items.length === PAGE_SIZE);
      } catch {
        if (!params.append) {
          setItems([]);
          setContentTypes([]);
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
      content_type: activeType ?? undefined,
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
        content_type: activeType ?? undefined,
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
      content_type: activeType ?? undefined,
      search,
      offset: newOffset,
      append: true,
    });
  }

  return (
    <SourcesPage
      items={items}
      contentTypes={contentTypes}
      activeType={activeType}
      search={search}
      loading={loading}
      hasMore={hasMore}
      onHome={() => navigate("/")}
      onSourceClick={(path) => navigate(`/doc/${path}`)}
      onTypeFilter={handleTypeFilter}
      onSearchChange={handleSearchChange}
      onLoadMore={handleLoadMore}
    />
  );
}
