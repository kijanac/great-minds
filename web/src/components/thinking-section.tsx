import { useState } from "react";
import { ChevronDown, ChevronRight, Globe, ListFilter, Search, Waypoints } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SourceRef, ThinkingBlock } from "@/lib/types";
import { displayTitle } from "@/lib/utils";

interface ThinkingSectionProps {
  blocks: ThinkingBlock[];
  streaming: boolean;
  onCardClick: (src: SourceRef) => void;
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
  const settledSources = allSources.filter((source) => source.pending !== true);
  const articles = settledSources.filter((s) => s.type === "article").length;
  const raw = settledSources.filter((s) => s.type === "raw").length;
  const webSearches = settledSources.filter((s) => s.type === "search" && s.scope === "web").length;
  const searches = settledSources.filter((s) => s.type === "search").length - webSearches;
  const queries = settledSources.filter((s) => s.type === "query").length;
  const links = settledSources.filter((s) => s.type === "links").length;

  const summaryParts: string[] = [];
  if (searches) summaryParts.push(`${searches} search${searches !== 1 ? "es" : ""}`);
  if (webSearches) summaryParts.push(`${webSearches} web search${webSearches !== 1 ? "es" : ""}`);
  if (queries) summaryParts.push(`${queries} filter${queries !== 1 ? "s" : ""}`);
  if (articles) summaryParts.push(`${articles} article${articles !== 1 ? "s" : ""} read`);
  if (raw) summaryParts.push(`${raw} source${raw !== 1 ? "s" : ""} read`);
  if (links) summaryParts.push(`${links} connection${links !== 1 ? "s" : ""} explored`);
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
              .map((src, i) => {
                if (src.type === "search")
                  return <SearchBadge key={`search:${i}:${src.label}`} source={src} />;
                if (src.type === "query")
                  return (
                    <FilterBadge
                      key={`query:${i}:${src.label}`}
                      summary={src.label}
                      pending={src.pending === true}
                    />
                  );
                return (
                  <ArticleBadge
                    key={`${src.type}:${i}:${src.label}`}
                    label={src.label}
                    title={src.title}
                    thinking={src.thinking ?? undefined}
                    active={activeCard === src.label}
                    pending={src.pending === true}
                    onClick={src.pending ? undefined : () => onCardClick(src)}
                    icon={
                      src.type === "links" ? (
                        <Waypoints size={9} className="mr-1.5 opacity-60" />
                      ) : undefined
                    }
                  />
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}

export function SearchBadge({ source }: { source: SourceRef }) {
  const web = source.scope === "web";
  const doc = source.path ? displayTitle(source.path, source.title) : null;
  return (
    <Badge
      variant="outline"
      title={web ? "web search" : "knowledge base search"}
      className={`cursor-default rounded-sm h-auto px-[9px] py-[3px] font-mono text-[length:var(--text-chrome)] tracking-[0.06em] whitespace-nowrap bg-ink-raised border-ink-border text-warm-ghost italic ${
        source.pending ? "animate-[pulse-fade_1.6s_ease-in-out_infinite]" : ""
      }`}
    >
      {web ? (
        <Globe size={9} className="mr-1.5 text-gold-muted" />
      ) : (
        <Search size={9} className="mr-1.5 opacity-60" />
      )}
      {source.label}
      {doc && <span className="opacity-60">{` · in ${doc}`}</span>}
    </Badge>
  );
}

export function FilterBadge({ summary, pending }: { summary: string; pending?: boolean }) {
  return (
    <Badge
      variant="outline"
      className={`cursor-default rounded-sm h-auto px-[9px] py-[3px] font-mono text-[length:var(--text-chrome)] tracking-[0.06em] whitespace-nowrap bg-ink-raised border-ink-border text-warm-ghost italic ${
        pending ? "animate-[pulse-fade_1.6s_ease-in-out_infinite]" : ""
      }`}
    >
      <ListFilter size={9} className="mr-1.5 opacity-60" />
      {summary}
    </Badge>
  );
}

export function ArticleBadge({
  label,
  title,
  thinking,
  active,
  pending,
  onClick,
  icon,
}: {
  label: string;
  title?: string | null;
  thinking?: string;
  active: boolean;
  pending?: boolean;
  onClick?: () => void;
  icon?: React.ReactNode;
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
      } ${pending ? "animate-[pulse-fade_1.6s_ease-in-out_infinite]" : ""}`}
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
      {icon}
      {displayTitle(label, title)}
    </Badge>
  );
}
