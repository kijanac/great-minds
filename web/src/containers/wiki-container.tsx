import { WikiPage } from "@/components/wiki-page";
import { useViewNavigate } from "@/hooks/use-view-navigate";
import { useWikiArticles } from "@/hooks/use-wiki-articles";

export function WikiContainer() {
  const navigate = useViewNavigate();
  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } = useWikiArticles();

  const items = data?.pages.flatMap((p) => p.items) ?? [];
  const total = data?.pages[0]?.pagination.total ?? 0;

  return (
    <WikiPage
      items={items}
      total={total}
      loading={isLoading || isFetchingNextPage}
      hasMore={hasNextPage ?? false}
      onHome={() => navigate("/")}
      onArticleClick={(slug) => navigate(`/doc/wiki/${slug}.md`)}
      onLoadMore={() => fetchNextPage()}
    />
  );
}
