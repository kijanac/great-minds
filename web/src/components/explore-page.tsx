import { Home } from "lucide-react";
import type { ReactNode } from "react";

import type { Orphan, RecentArticle, UnmentionedLink, UnresolvedCitation } from "@/api/explore";
import type { ContentTypeFacet } from "@/api/sources";
import { Button } from "@/components/ui/button";
import { CHIP_BASE, CHIP_INACTIVE } from "@/lib/chip";
import { cn, formatShortDate } from "@/lib/utils";

interface ExplorePageProps {
  orphans: Orphan[];
  dirtyCount: number;
  unresolvedCitations: UnresolvedCitation[];
  unmentionedLinks: UnmentionedLink[];
  recentArticles: RecentArticle[];
  contentTypes: ContentTypeFacet[];
  loading: boolean;
  onHome: () => void;
  onArticleClick: (path: string) => void;
  onOrphanClick: (slug: string) => void;
  onExploreWiki: () => void;
  onExploreSources: (type?: string) => void;
  ingestionZone: ReactNode;
}

const CHIP_CLASS = cn(CHIP_BASE, CHIP_INACTIVE);

export function ExplorePage({
  orphans,
  dirtyCount,
  unresolvedCitations,
  unmentionedLinks,
  recentArticles,
  contentTypes,
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
  const hasSourceTypes = contentTypes.length > 0;
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
            <p className="text-[length:var(--text-body)] text-warm-faint animate-[pulse-fade_1.6s_ease-in-out_infinite]">
              Loading...
            </p>
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
                <div className="flex flex-wrap items-center gap-2">
                  {hasSourceTypes && (
                    <>
                      <button onClick={() => onExploreSources()} className={CHIP_CLASS}>
                        all sources · {contentTypes.reduce((s, ct) => s + ct.count, 0)}
                      </button>
                      {contentTypes.map((ct) => (
                        <button
                          key={ct.value}
                          onClick={() => onExploreSources(ct.value)}
                          className={CHIP_CLASS}
                        >
                          {ct.value} · {ct.count}
                        </button>
                      ))}
                    </>
                  )}
                  {hasArticles && (
                    <button onClick={onExploreWiki} className={CHIP_CLASS}>
                      explore wiki
                    </button>
                  )}
                </div>
              </section>

              {hasDirty && (
                <section className="mb-10">
                  <h2 className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase mb-4">
                    needs recompile
                  </h2>
                  <p className="font-serif text-[length:var(--text-body)] text-warm-dim">
                    {dirtyCount} article{dirtyCount === 1 ? "" : "s"} drifted from the current topic
                    registry and will be refreshed on the next compile.
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
                          {a.metadata.title}
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

          <div className="mt-4">{ingestionZone}</div>
        </div>
      </div>
    </div>
  );
}
