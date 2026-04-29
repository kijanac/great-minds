import { Home, Search } from "lucide-react";

import type { ContentTypeFacet, SourceDocumentSummary } from "@/api/sources";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CHIP_ACTIVE, CHIP_BASE, CHIP_INACTIVE } from "@/lib/chip";
import { cn, formatShortDate } from "@/lib/utils";

interface SourcesPageProps {
  items: SourceDocumentSummary[];
  contentTypes: ContentTypeFacet[];
  activeType: string | null;
  search: string;
  loading: boolean;
  hasMore: boolean;
  onHome: () => void;
  onSourceClick: (path: string) => void;
  onTypeFilter: (type: string | null) => void;
  onSearchChange: (query: string) => void;
  onLoadMore: () => void;
}

export function SourcesPage({
  items,
  contentTypes,
  activeType,
  search,
  loading,
  hasMore,
  onHome,
  onSourceClick,
  onTypeFilter,
  onSearchChange,
  onLoadMore,
}: SourcesPageProps) {
  const totalCount = contentTypes.reduce((sum, ct) => sum + ct.count, 0);

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
            sources
          </span>
        </div>

        <div className="flex items-center gap-2 max-w-[300px] w-full">
          <Search size={14} className="text-muted-foreground shrink-0" />
          <Input
            className="h-7 bg-transparent dark:bg-transparent border-ink-border rounded-sm font-serif text-[length:var(--text-small)] text-foreground px-3 caret-gold placeholder:text-input focus-visible:ring-0 focus-visible:border-gold-dim"
            placeholder="Search sources..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[740px] mx-auto px-4 md:px-10 pt-8 pb-20">
          {contentTypes.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-8">
              <button
                onClick={() => onTypeFilter(null)}
                className={cn(CHIP_BASE, activeType === null ? CHIP_ACTIVE : CHIP_INACTIVE)}
              >
                all · {totalCount}
              </button>
              {contentTypes.map((ct) => (
                <button
                  key={ct.value}
                  onClick={() =>
                    onTypeFilter(
                      activeType === ct.value ? null : ct.value,
                    )
                  }
                  className={cn(
                    CHIP_BASE,
                    activeType === ct.value ? CHIP_ACTIVE : CHIP_INACTIVE,
                  )}
                >
                  {ct.value} · {ct.count}
                </button>
              ))}
            </div>
          )}

          {loading && items.length === 0 && (
            <p className="text-[length:var(--text-body)] text-warm-faint animate-[pulse-fade_1.6s_ease-in-out_infinite]">
              Loading...
            </p>
          )}

          {!loading && items.length === 0 && (
            <div className="text-center pt-8">
              <p className="font-serif text-[length:var(--text-body)] text-warm-dim mb-2">
                {search ? "No sources match your search" : "No sources yet"}
              </p>
              {!search && (
                <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost">
                  drop files on the explore page to ingest sources
                </p>
              )}
            </div>
          )}

          {items.length > 0 && (
            <div className="space-y-1">
              {items.map((item) => (
                <Button
                  key={item.file_path}
                  variant="ghost"
                  onClick={() => onSourceClick(item.file_path)}
                  className="w-full h-auto py-2.5 px-3 rounded-sm justify-between hover:bg-ink-raised group"
                >
                  <div className="flex flex-col items-start gap-0.5 min-w-0 flex-1">
                    <span className="font-serif text-[length:var(--text-body)] text-warm-dim group-hover:text-warm transition-colors truncate w-full text-left">
                      {item.metadata.title}
                    </span>
                    {(item.metadata.author || item.metadata.origin) && (
                      <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost truncate w-full text-left">
                        {[item.metadata.author, item.metadata.origin]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    {!item.compiled && (
                      <span className="w-1.5 h-1.5 rounded-full bg-gold/60" title="Uncompiled" />
                    )}
                    <span className="font-mono text-[length:var(--text-chrome)] text-warm-ghost">
                      {formatShortDate(item.updated_at)}
                    </span>
                  </div>
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
            <p className="mt-6 text-center text-[length:var(--text-chrome)] text-warm-faint animate-[pulse-fade_1.6s_ease-in-out_infinite] font-mono">
              Loading...
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
