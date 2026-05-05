import { type QueryKey, useInfiniteQuery } from "@tanstack/react-query";

import type { PageInfo } from "@/api/schemas";

interface OffsetPage<T> {
  items: T[];
  pagination: PageInfo;
}

interface UseOffsetInfiniteQueryOptions<T> {
  queryKey: QueryKey;
  queryFn: (params: { limit: number; offset: number }) => Promise<OffsetPage<T>>;
  pageSize: number;
  enabled?: boolean;
}

export function useOffsetInfiniteQuery<T>({
  queryKey,
  queryFn,
  pageSize,
  enabled,
}: UseOffsetInfiniteQueryOptions<T>) {
  return useInfiniteQuery<OffsetPage<T>>({
    queryKey,
    enabled,
    queryFn: ({ pageParam }) => queryFn({ limit: pageSize, offset: pageParam as number }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const next = lastPage.pagination.offset + lastPage.items.length;
      return next < lastPage.pagination.total ? next : undefined;
    },
  });
}
