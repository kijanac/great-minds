import { useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ThinkingBlock } from "@/lib/types";
import { displayTitle } from "@/lib/utils";

interface ThinkingSectionProps {
  blocks: ThinkingBlock[];
  streaming: boolean;
  onCardClick: (path: string) => void;
  activeCard: string | null;
}

export function ThinkingSection({
  blocks,
  streaming,
  onCardClick,
  activeCard,
}: ThinkingSectionProps) {
  // null = user hasn't overridden, follow streaming state
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const open = userOverride ?? streaming;

  if (blocks.length === 0 && !streaming) return null;

  const allSources = blocks.flatMap((b) => b.sources);
  const articles = allSources.filter((s) => s.type === "article").length;
  const raw = allSources.filter((s) => s.type === "raw").length;
  const searches = allSources.filter((s) => s.type === "search").length;

  const summaryParts: string[] = [];
  if (searches) summaryParts.push(`${searches} search${searches !== 1 ? "es" : ""}`);
  if (articles) summaryParts.push(`${articles} article${articles !== 1 ? "s" : ""} read`);
  if (raw) summaryParts.push(`${raw} source${raw !== 1 ? "s" : ""} read`);
  const summary = summaryParts.join(", ") || "no sources";

  return (
    <div className="mb-4">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setUserOverride(open ? false : true)}
        className="h-auto p-0 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:text-gold hover:bg-transparent gap-1.5"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {streaming ? (
          <span className="animate-[pulse-fade_1.6s_ease-in-out_infinite]">
            traversing knowledge base...
          </span>
        ) : (
          <span>{summary}</span>
        )}
      </Button>

      {open && (
        <div className="mt-2 border-l-2 border-interactive-ghost pl-3.5 space-y-3">
          <div className="relative z-[200] flex flex-wrap gap-[5px]">
            {blocks
              .flatMap((b) => b.sources)
              .map((src) =>
                src.type === "search" ? (
                  <SearchBadge key={`search:${src.label}`} query={src.label} />
                ) : (
                  <ArticleBadge
                    key={`${src.type}:${src.label}`}
                    label={src.label}
                    title={src.title}
                    thinking={src.thinking}
                    active={activeCard === src.label}
                    onClick={() => onCardClick(src.label)}
                  />
                ),
              )}
          </div>
        </div>
      )}
    </div>
  );
}

function SearchBadge({ query }: { query: string }) {
  return (
    <Badge
      variant="outline"
      className="cursor-default rounded-sm h-auto px-[9px] py-[3px] font-mono text-[length:var(--text-chrome)] tracking-[0.06em] whitespace-nowrap bg-ink-raised border-ink-border text-warm-ghost italic"
    >
      <Search size={9} className="mr-1.5 opacity-60" />
      {query}
    </Badge>
  );
}

function ArticleBadge({
  label,
  title,
  thinking,
  active,
  onClick,
}: {
  label: string;
  title?: string | null;
  thinking?: string;
  active: boolean;
  onClick?: () => void;
}) {
  return (
    <Badge
      variant="outline"
      onClick={onClick}
      title={thinking}
      className={`rounded-sm h-auto px-[9px] py-[3px] font-mono text-[length:var(--text-chrome)] tracking-[0.06em] whitespace-nowrap transition-all ${
        onClick ? "cursor-pointer" : "cursor-default"
      } ${
        active
          ? "border-gold-dim text-gold bg-interactive-dim"
          : "bg-ink-raised border-ink-border text-card-foreground hover:border-gold-dim hover:text-gold"
      }`}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {displayTitle(label, title)}
    </Badge>
  );
}
