import { fetchWikiArticles } from "@/api/wiki";
import { useActiveBrainId } from "@/hooks/use-brain";
import { useOffsetInfiniteQuery } from "@/hooks/use-offset-infinite-query";

const PAGE_SIZE = 50;

export function useWikiArticles() {
  const brainId = useActiveBrainId();
  return useOffsetInfiniteQuery({
    queryKey: ["wiki-articles", brainId],
    enabled: brainId != null,
    pageSize: PAGE_SIZE,
    queryFn: (params) => fetchWikiArticles(params),
  });
}
