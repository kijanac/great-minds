import { Home } from "lucide-react";

import type { WikiArticleOverview } from "@/api/wiki";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatShortDate } from "@/lib/utils";

interface WikiPageProps {
  items: WikiArticleOverview[];
  total: number;
  loading: boolean;
  hasMore: boolean;
  onHome: () => void;
  onArticleClick: (slug: string) => void;
  onLoadMore: () => void;
}

export function WikiPage({
  items,
  total,
  loading,
  hasMore,
  onHome,
  onArticleClick,
  onLoadMore,
}: WikiPageProps) {
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <div className="shrink-0 flex items-center justify-between px-4 md:px-6 pt-4 pb-3 border-b border-ink-subtle gap-3">
        <div className="flex items-center gap-4 shrink-0">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onHome}
            className="text-muted-foreground hover:text-gold hover:bg-transparent"
          >
            <Home size={14} />
          </Button>
          <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase hidden md:inline">
            wiki
          </span>
        </div>
        {total > 0 && (
          <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost shrink-0">
            {total} {total === 1 ? "article" : "articles"}
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[740px] mx-auto px-4 md:px-10 pt-8 pb-20">
          {loading && items.length === 0 && (
            <div className="space-y-4">
              {[0, 1, 2].map((idx) => (
                <div key={idx} className="space-y-2 px-3 py-3">
                  <Skeleton className="h-5 w-2/3 bg-ink-raised" />
                  <Skeleton className="h-4 w-full bg-ink-raised" />
                  <Skeleton className="h-4 w-5/6 bg-ink-raised" />
                </div>
              ))}
            </div>
          )}

          {!loading && items.length === 0 && (
            <div className="text-center pt-8">
              <p className="font-serif text-[length:var(--text-body)] text-warm-dim mb-2">
                No articles yet
              </p>
              <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost">
                ingest sources and run a compile to generate articles
              </p>
            </div>
          )}

          {items.length > 0 && (
            <div className="space-y-1">
              {items.map((item) => (
                <Button
                  key={item.slug}
                  variant="ghost"
                  onClick={() => onArticleClick(item.slug)}
                  className="w-full h-auto py-3 px-3 rounded-sm justify-between hover:bg-ink-raised group items-start whitespace-normal"
                >
                  <div className="flex flex-col items-start gap-1 min-w-0 flex-1">
                    <span className="font-serif text-[length:var(--text-body)] text-warm-dim group-hover:text-warm transition-colors truncate w-full text-left">
                      {item.title || item.slug}
                    </span>
                    {item.precis && (
                      <span className="font-serif text-[length:var(--text-small)] text-warm-ghost text-left line-clamp-2 w-full break-words">
                        {item.precis}
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[length:var(--text-chrome)] text-warm-ghost shrink-0 ml-4 mt-0.5">
                    {formatShortDate(item.updated_at)}
                  </span>
                </Button>
              ))}
            </div>
          )}

          {hasMore && !loading && (
            <div className="mt-6 text-center">
              <Button
                variant="ghost"
                onClick={onLoadMore}
                className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:text-gold hover:bg-transparent h-auto px-3 py-1.5"
              >
                load more
              </Button>
            </div>
          )}

          {loading && items.length > 0 && (
            <div className="mt-6 space-y-2 px-3">
              <Skeleton className="h-4 w-1/2 bg-ink-raised" />
              <Skeleton className="h-4 w-2/3 bg-ink-raised" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
