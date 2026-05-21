import { Home } from "lucide-react";
import type { ReactNode } from "react";

import type { UnmentionedLink, UnresolvedCitation } from "@/api/explore";
import type { WikiArticleOverview } from "@/api/wiki";
import type { SourceTypeFacet } from "@/api/sources";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FILTER_CHIP_CLASS } from "@/lib/control-styles";
import { formatShortDate } from "@/lib/utils";

interface ExplorePageProps {
  orphans: WikiArticleOverview[];
  dirtyCount: number;
  unresolvedCitations: UnresolvedCitation[];
  unmentionedLinks: UnmentionedLink[];
  recentArticles: WikiArticleOverview[];
  sourceTypes: SourceTypeFacet[];
  loading: boolean;
  onHome: () => void;
  onArticleClick: (path: string) => void;
  onOrphanClick: (slug: string) => void;
  onExploreWiki: () => void;
  onExploreSources: (type?: string) => void;
  ingestionZone: ReactNode;
}

export function ExplorePage({
  orphans,
  dirtyCount,
  unresolvedCitations,
  unmentionedLinks,
  recentArticles,
  sourceTypes,
  loading,
  onHome,
  onArticleClick,
  onOrphanClick,
  onExploreWiki,
  onExploreSources,
  ingestionZone,
}: ExplorePageProps) {
  const hasOrphans = orphans.length > 0;
  const hasDirty = dirtyCount > 0;
  const hasUnresolved = unresolvedCitations.length > 0;
  const hasUnmentioned = unmentionedLinks.length > 0;
  const hasArticles = recentArticles.length > 0;
  const hasSourceTypes = sourceTypes.length > 0;
  const hasContent =
    hasOrphans || hasDirty || hasUnresolved || hasUnmentioned || hasArticles || hasSourceTypes;

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <div className="shrink-0 flex items-center px-4 md:px-6 pt-4 pb-3 border-b border-ink-subtle gap-4">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onHome}
          className="text-muted-foreground hover:text-gold hover:bg-transparent"
        >
          <Home size={14} />
        </Button>
        <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase hidden md:inline">
          explore
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[740px] mx-auto px-4 md:px-10 pt-8 pb-20">
          {loading ? (
            <div className="space-y-8">
              <div className="flex flex-wrap gap-2">
                <Skeleton className="h-7 w-28 bg-ink-raised" />
                <Skeleton className="h-7 w-24 bg-ink-raised" />
                <Skeleton className="h-7 w-32 bg-ink-raised" />
              </div>
              <div className="space-y-3">
                <Skeleton className="h-4 w-32 bg-ink-raised" />
                <Skeleton className="h-10 w-full bg-ink-raised" />
                <Skeleton className="h-10 w-5/6 bg-ink-raised" />
              </div>
            </div>
          ) : !hasContent ? (
            <div className="text-center pt-8">
              <p className="font-serif text-[length:var(--text-body)] text-warm-dim mb-2">
                Nothing to explore yet
              </p>
              <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost mb-6">
                drop some sources below to get started
              </p>
            </div>
          ) : (
            <>
              <section className="mb-10">
                <ToggleGroup multiple={false} variant="outline" size="sm" className="flex-wrap">
                  {hasSourceTypes && (
                    <>
                      <ToggleGroupItem
                        value="all-sources"
                        onClick={() => onExploreSources()}
                        className={FILTER_CHIP_CLASS}
                      >
                        all sources · {sourceTypes.reduce((s, ct) => s + ct.count, 0)}
                      </ToggleGroupItem>
                      {sourceTypes.map((ct) => (
                        <ToggleGroupItem
                          key={ct.value}
                          value={`source-${ct.value}`}
                          onClick={() => onExploreSources(ct.value)}
                          className={FILTER_CHIP_CLASS}
                        >
                          {ct.value} · {ct.count}
                        </ToggleGroupItem>
                      ))}
                    </>
                  )}
                  {hasArticles && (
                    <ToggleGroupItem
                      value="explore-wiki"
                      onClick={onExploreWiki}
                      className={FILTER_CHIP_CLASS}
                    >
                      explore wiki
                    </ToggleGroupItem>
                  )}
                </ToggleGroup>
              </section>

              {hasDirty && (
                <section className="mb-10">
                  <h2 className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase mb-4">
                    needs update
                  </h2>
                  <p className="font-serif text-[length:var(--text-body)] text-warm-dim">
                    {dirtyCount} article{dirtyCount === 1 ? "" : "s"} drifted from the current topic
                    registry and will be refreshed on the next update.
                  </p>
                </section>
              )}

              {hasUnresolved && (
                <section className="mb-10">
                  <h2 className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase mb-4">
                    broken links
                  </h2>
                  <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost mb-5">
                    articles citing wiki slugs that have no matching topic
                  </p>
                  <div className="space-y-1">
                    {unresolvedCitations.map((u, i) => (
                      <div
                        key={`${u.source_slug}-${u.missing_slug}-${i}`}
                        className="py-2.5 px-3 rounded-sm"
                      >
                        <div className="font-serif text-[length:var(--text-body)] text-warm-dim">
                          {u.source_title}
                        </div>
                        <div className="font-mono text-[length:var(--text-chrome)] text-warm-ghost mt-0.5">
                          → {u.missing_slug}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {hasOrphans && (
                <section className="mb-10">
                  <h2 className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase mb-4">
                    orphan articles
                  </h2>
                  <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost mb-5">
                    rendered articles that no other article links to
                  </p>
                  <div className="space-y-1">
                    {orphans.map((o) => (
                      <Button
                        key={o.slug}
                        variant="ghost"
                        onClick={() => onOrphanClick(o.slug)}
                        className="w-full h-auto py-2.5 px-3 rounded-sm justify-between hover:bg-ink-raised group"
                      >
                        <span className="font-serif text-[length:var(--text-body)] text-warm-dim group-hover:text-warm transition-colors truncate text-left">
                          {o.title}
                        </span>
                        <span className="font-mono text-[length:var(--text-chrome)] text-warm-ghost shrink-0 ml-4">
                          {o.slug}
                        </span>
                      </Button>
                    ))}
                  </div>
                </section>
              )}

              {hasUnmentioned && (
                <section className="mb-10">
                  <h2 className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase mb-4">
                    missing connections
                  </h2>
                  <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost mb-5">
                    links the topic registry intended but the article doesn't include
                  </p>
                  <div className="space-y-1">
                    {unmentionedLinks.map((u, i) => (
                      <div
                        key={`${u.source_slug}-${u.target_slug}-${i}`}
                        className="py-2.5 px-3 rounded-sm"
                      >
                        <div className="font-serif text-[length:var(--text-body)] text-warm-dim">
                          {u.source_title}
                        </div>
                        <div className="font-mono text-[length:var(--text-chrome)] text-warm-ghost mt-0.5">
                          → {u.target_title}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {hasArticles && (
                <section className="mb-10">
                  <h2 className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase mb-4">
                    recent articles
                  </h2>
                  <div className="space-y-1">
                    {recentArticles.map((a) => (
                      <Button
                        key={a.file_path}
                        variant="ghost"
                        onClick={() => onArticleClick(a.file_path)}
                        className="w-full h-auto py-2.5 px-3 rounded-sm justify-between hover:bg-ink-raised group"
                      >
                        <span className="font-serif text-[length:var(--text-body)] text-warm-dim group-hover:text-warm transition-colors truncate text-left">
                          {a.title}
                        </span>
                        <span className="font-mono text-[length:var(--text-chrome)] text-warm-ghost shrink-0 ml-4">
                          {formatShortDate(a.updated_at)}
                        </span>
                      </Button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}

          {ingestionZone && <div className="mt-4">{ingestionZone}</div>}
        </div>
      </div>
    </div>
  );
}
