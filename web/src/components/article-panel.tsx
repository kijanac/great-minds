import { Maximize2, X } from "lucide-react";
import Markdown from "react-markdown";

import { remarkPlugins, rehypePlugins } from "@/lib/markdown";
import { displayTitle } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { SourceRef } from "@/lib/types";
import type { DocChunk, LinkedArticles, LinkItem } from "@/api/doc";

export type PanelContent =
  | { mode: "doc"; body: string }
  | { mode: "chunks"; chunks: DocChunk[] }
  | { mode: "links"; links: LinkedArticles };

// Obsidian block-ref markers (`^pN`) are baked into raw bodies; strip from view.
const BLOCK_REF_RE = /\s*\^p\d+(?=\n|$)/gm;

const PROSE =
  "text-[length:var(--text-small)] leading-[1.76] text-warm-faint [&_p]:mb-[13px] [&_h2]:text-[length:var(--text-body)] [&_h2]:font-bold [&_h2]:text-foreground [&_h2]:mt-5 [&_h2]:mb-2 [&_h3]:text-[length:var(--text-caption)] [&_h3]:font-mono [&_h3]:text-gold [&_h3]:tracking-[0.1em] [&_h3]:uppercase [&_h3]:mt-4 [&_h3]:mb-2";

interface ArticlePanelProps {
  card: SourceRef;
  content: PanelContent | null;
  loading: boolean;
  onClose: () => void;
  onFullScreen: () => void;
  onOpenPath: (path: string) => void;
}

function subtitle(card: SourceRef, content: PanelContent | null): string {
  if (card.type === "links") return "connections the agent saw";
  if (content?.mode === "chunks") {
    const ranges = (card.ranges ?? [])
      .map((r) => (r.start === r.end ? `¶${r.start}` : `¶${r.start}–${r.end}`))
      .join(", ");
    return ranges ? `${ranges} · what the agent read` : "what the agent read";
  }
  const kind = card.label.startsWith("wiki/") ? "wiki article" : "raw source";
  return `${kind} · full document`;
}

export function ArticlePanel({
  card,
  content,
  loading,
  onClose,
  onFullScreen,
  onOpenPath,
}: ArticlePanelProps) {
  const headingTitle = displayTitle(card.label, card.title);

  return (
    <div className="fixed top-0 right-0 w-full md:w-[370px] h-screen bg-ink-panel border-l border-ink-subtle flex flex-col z-[200] shadow-none md:shadow-[-24px_0_60px_rgba(80,60,30,0.12)] dark:md:shadow-[-24px_0_60px_rgba(0,0,0,0.6)] animate-[panel-in_0.28s_cubic-bezier(0.4,0,0.2,1)]">
      <div className="px-5 pt-5 pb-3.5 border-b border-ink-subtle shrink-0">
        <div className="flex items-start justify-between gap-2 mb-[9px]">
          <span className="text-[length:var(--text-body)] font-bold text-foreground min-w-0 break-words">
            {headingTitle}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onFullScreen}
              className="text-muted-foreground hover:text-gold hover:bg-transparent shrink-0"
              title="Open full screen"
            >
              <Maximize2 size={12} />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              className="text-muted-foreground hover:text-warm-faint hover:bg-transparent shrink-0"
            >
              <X size={14} />
            </Button>
          </div>
        </div>
        <span
          title={card.label}
          className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] uppercase text-interactive-dim"
        >
          {subtitle(card, content)}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-5 py-[18px]">
          {loading && (
            <div className="space-y-3">
              <Skeleton className="h-4 w-full bg-ink-raised" />
              <Skeleton className="h-4 w-11/12 bg-ink-raised" />
              <Skeleton className="h-4 w-4/5 bg-ink-raised" />
              <Skeleton className="h-4 w-2/3 bg-ink-raised" />
            </div>
          )}

          {!loading && content?.mode === "doc" && (
            <div className={PROSE}>
              <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
                {content.body.replace(BLOCK_REF_RE, "")}
              </Markdown>
            </div>
          )}

          {!loading && content?.mode === "chunks" && (
            <div className="space-y-5">
              {content.chunks.length === 0 ? (
                <p className="text-[length:var(--text-small)] text-warm-faint">
                  No passages found.
                </p>
              ) : (
                content.chunks.map((c) => (
                  <div key={c.chunk_index}>
                    <div className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted mb-1">
                      ¶{c.chunk_index}
                      {c.heading ? ` · ${c.heading}` : ""}
                    </div>
                    <div className={PROSE}>
                      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
                        {c.body.replace(BLOCK_REF_RE, "")}
                      </Markdown>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {!loading && content?.mode === "links" && (
            <div className="space-y-5">
              <LinkGroup label="cites →" items={content.links.outgoing} onOpenPath={onOpenPath} />
              <LinkGroup
                label="cited by ←"
                items={content.links.incoming}
                onOpenPath={onOpenPath}
              />
            </div>
          )}

          {!loading && !content && (
            <p className="text-[length:var(--text-small)] text-warm-faint">Not found.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function LinkGroup({
  label,
  items,
  onOpenPath,
}: {
  label: string;
  items: LinkItem[];
  onOpenPath: (path: string) => void;
}) {
  return (
    <div>
      <div className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] uppercase text-interactive-dim mb-2">
        {label}
      </div>
      {items.length === 0 ? (
        <p className="text-[length:var(--text-small)] text-warm-ghost italic">none</p>
      ) : (
        <ul className="space-y-1">
          {items.map((it) => (
            <li key={it.file_path}>
              <button
                type="button"
                onClick={() => onOpenPath(it.file_path)}
                className="text-left text-[length:var(--text-small)] text-warm-dim hover:text-gold transition-colors"
              >
                {it.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
