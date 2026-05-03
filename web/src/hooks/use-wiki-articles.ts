import { fetchWikiArticles } from "@/api/wiki";
import { useActiveVaultId } from "@/hooks/use-vault";
import { useOffsetInfiniteQuery } from "@/hooks/use-offset-infinite-query";

const PAGE_SIZE = 50;

export function useWikiArticles() {
  const vaultId = useActiveVaultId();
  return useOffsetInfiniteQuery({
    queryKey: ["wiki-articles", vaultId],
    enabled: vaultId != null,
    pageSize: PAGE_SIZE,
    queryFn: (params) => fetchWikiArticles(params),
  });
}
