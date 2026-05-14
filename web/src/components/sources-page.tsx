import { Home, Search } from "lucide-react";

import type { SourceTypeFacet, SourceDocumentSummary } from "@/api/sources";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FILTER_CHIP_CLASS } from "@/lib/control-styles";
import { formatShortDate } from "@/lib/utils";

const ALL_TYPES_VALUE = "__all";

interface SourcesPageProps {
  items: SourceDocumentSummary[];
  sourceTypes: SourceTypeFacet[];
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
  sourceTypes,
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
  const totalCount = sourceTypes.reduce((sum, ct) => sum + ct.count, 0);

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
          {sourceTypes.length > 0 && (
            <ToggleGroup
              multiple={false}
              value={[activeType ?? ALL_TYPES_VALUE]}
              onValueChange={(vals) => {
                const next = vals[0];
                onTypeFilter(!next || next === ALL_TYPES_VALUE ? null : next);
              }}
              variant="outline"
              size="sm"
              className="mb-8 flex-wrap"
            >
              <ToggleGroupItem value={ALL_TYPES_VALUE} className={FILTER_CHIP_CLASS}>
                all · {totalCount}
              </ToggleGroupItem>
              {sourceTypes.map((ct) => (
                <ToggleGroupItem key={ct.value} value={ct.value} className={FILTER_CHIP_CLASS}>
                  {ct.value} · {ct.count}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}

          {loading && items.length === 0 && (
            <div className="space-y-3">
              {[0, 1, 2, 3].map((idx) => (
                <div key={idx} className="flex items-center justify-between gap-4 px-3 py-2.5">
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-5 w-2/3 bg-ink-raised" />
                    <Skeleton className="h-3 w-1/2 bg-ink-raised" />
                  </div>
                  <Skeleton className="h-3 w-16 bg-ink-raised" />
                </div>
              ))}
            </div>
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
                      {item.title ?? item.file_path}
                    </span>
                    {(item.author || item.origin) && (
                      <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost truncate w-full text-left">
                        {[item.author, item.origin].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
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
