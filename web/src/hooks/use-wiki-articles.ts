import { useInfiniteQuery } from "@tanstack/react-query";

import { fetchWikiArticles } from "@/api/wiki";
import { useActiveBrainId } from "@/hooks/use-brain";

const PAGE_SIZE = 50;

export function useWikiArticles() {
  const brainId = useActiveBrainId();
  return useInfiniteQuery({
    queryKey: ["wiki-articles", brainId],
    enabled: brainId != null,
    queryFn: ({ pageParam }) =>
      fetchWikiArticles({ limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const next = lastPage.pagination.offset + lastPage.items.length;
      return next < lastPage.pagination.total ? next : undefined;
    },
  });
}
