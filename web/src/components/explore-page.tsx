import { Home } from "lucide-react";
import type { ReactNode } from "react";

import type {
  Contradiction,
  Orphan,
  RecentArticle,
  ResearchSuggestion,
} from "@/api/explore";
import type { ContentTypeCount } from "@/api/sources";
import { Button } from "@/components/ui/button";
import { CHIP_BASE, CHIP_INACTIVE } from "@/lib/chip";
import { cn, formatShortDate } from "@/lib/utils";

interface ExplorePageProps {
  suggestions: ResearchSuggestion[];
  contradictions: Contradiction[];
  orphans: Orphan[];
  dirtyCount: number;
  recentArticles: RecentArticle[];
  contentTypes: ContentTypeCount[];
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
  suggestions,
  contradictions,
  orphans,
  dirtyCount,
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
  const hasSuggestions = suggestions.length > 0;
  const hasContradictions = contradictions.length > 0;
  const hasOrphans = orphans.length > 0;
  const hasDirty = dirtyCount > 0;
  const hasArticles = recentArticles.length > 0;
  const hasSourceTypes = contentTypes.length > 0;
  const hasContent =
    hasSuggestions ||
    hasContradictions ||
    hasOrphans ||
    hasDirty ||
    hasArticles ||
    hasSourceTypes;

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
                      <button
                        onClick={() => onExploreSources()}
                        className={CHIP_CLASS}
                      >
                        all sources ·{" "}
                        {contentTypes.reduce((s, ct) => s + ct.count, 0)}
                      </button>
                      {contentTypes.map((ct) => (
                        <button
                          key={ct.content_type}
                          onClick={() => onExploreSources(ct.content_type)}
                          className={CHIP_CLASS}
                        >
                          {ct.content_type} · {ct.count}
                        </button>
                      ))}
                    </>
                  )}
                  {hasArticles && (
                    <button
                      onClick={onExploreWiki}
                      className={CHIP_CLASS}
                    >
                      explore wiki
                    </button>
                  )}
                </div>
              </section>

              {hasSuggestions && (
                <section className="mb-10">
                  <h2 className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase mb-4">
                    research suggestions
                  </h2>
                  <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost mb-5">
                    topics your knowledge base mentions but doesn't cover deeply
                  </p>
                  <div className="space-y-3">
                    {suggestions.map((s) => (
                      <div
                        key={s.topic}
                        className="py-3 px-4 rounded-sm border border-ink-border hover:border-gold-dim transition-colors"
                      >
                        <span className="font-serif text-[length:var(--text-body)] text-warm">
                          {s.topic}
                        </span>
                        <div className="mt-1 font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost">
                          mentioned in {s.usage_count} document{s.usage_count !== 1 && "s"}
                          {s.mentioned_in.length > 0 && (
                            <span className="text-warm-ghost">
                              {" "}· {s.mentioned_in.slice(0, 3).join(", ")}
                              {s.mentioned_in.length > 3 && ` +${s.mentioned_in.length - 3}`}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {hasDirty && (
                <section className="mb-10">
                  <h2 className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase mb-4">
                    needs recompile
                  </h2>
                  <p className="font-serif text-[length:var(--text-body)] text-warm-dim">
                    {dirtyCount} article{dirtyCount === 1 ? "" : "s"} drifted from
                    the current concept registry and will be refreshed on the next
                    compile.
                  </p>
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
                          {o.canonical_label}
                        </span>
                        <span className="font-mono text-[length:var(--text-chrome)] text-warm-ghost shrink-0 ml-4">
                          {o.slug}
                        </span>
                      </Button>
                    ))}
                  </div>
                </section>
              )}

              {hasContradictions && (
                <section className="mb-10">
                  <h2 className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase mb-4">
                    contradictions
                  </h2>
                  <div className="space-y-3">
                    {contradictions.map((c, i) => (
                      <div
                        key={i}
                        className="py-3 px-4 rounded-sm border border-ink-border"
                      >
                        <p className="font-serif text-[length:var(--text-body)] text-warm-dim">
                          {c.description}
                        </p>
                        <div className="mt-1 font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost">
                          {c.articles.join(" · ")}
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

          <div className="mt-4">{ingestionZone}</div>
        </div>
      </div>
    </div>
  );
}
