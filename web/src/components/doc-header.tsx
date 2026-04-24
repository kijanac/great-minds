import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { Document } from "@/api/doc";
import { CHIP_BASE, CHIP_INACTIVE } from "@/lib/chip";
import { cn } from "@/lib/utils";

interface DocHeaderProps {
  document: Document;
  archived?: boolean;
  supersededBy?: string | null;
  onSupersessorClick?: (slug: string) => void;
}

/**
 * Chrome block above the document body: title, subtitle, metadata
 * row, tag chips, origin link, and a collapsed "more metadata" panel
 * for per-brain custom fields that don't have a dedicated slot.
 *
 * Works for both wiki and raw documents — missing fields (e.g. author
 * on a wiki doc, description on a raw doc) render nothing.
 */
export function DocHeader({
  document,
  archived = false,
  supersededBy = null,
  onSupersessorClick,
}: DocHeaderProps) {
  const [extraOpen, setExtraOpen] = useState(false);

  const metaParts: string[] = [];
  if (document.author) metaParts.push(document.author);
  if (document.published_date) metaParts.push(document.published_date);
  if (document.genre) metaParts.push(document.genre);

  const extraEntries = Object.entries(document.extra_metadata ?? {}).filter(
    ([k]) => k !== "topic_id", // internal identifier, not for display
  );

  return (
    <header className="mb-10">
      {archived && (
        <div className="mb-6 px-4 py-3 rounded-sm border border-gold-dim bg-ink-raised">
          <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted uppercase mb-1">
            archived article
          </p>
          <p className="font-serif text-[length:var(--text-body)] text-warm-dim">
            {supersededBy ? (
              <>
                This concept has been retired. See{" "}
                <button
                  type="button"
                  onClick={() => onSupersessorClick?.(supersededBy)}
                  className="text-gold hover:text-gold-bright underline underline-offset-2"
                >
                  {supersededBy}
                </button>{" "}
                for the current version.
              </>
            ) : (
              <>This concept has been retired. No successor has been identified.</>
            )}
          </p>
        </div>
      )}

      <h1 className="text-[length:var(--text-title)] font-bold text-foreground mb-3">
        {document.title}
      </h1>

      {document.precis && (
        <p className="font-serif text-[length:var(--text-body)] text-warm-dim italic leading-[1.6] mb-4">
          {document.precis}
        </p>
      )}

      {metaParts.length > 0 && (
        <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint mb-3">
          {metaParts.join(" · ")}
        </p>
      )}

      {document.tags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {document.tags.map((tag) => (
            <span key={tag} className={cn(CHIP_BASE, CHIP_INACTIVE)}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {(document.url || document.origin) && (
        <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost mb-3">
          {document.url ? (
            <a
              href={document.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-gold-muted hover:text-gold underline underline-offset-2 decoration-gold/30"
            >
              from {document.origin || document.url}
              <ExternalLink size={11} />
            </a>
          ) : (
            <>from {document.origin}</>
          )}
        </p>
      )}

      {extraEntries.length > 0 && (
        <Collapsible open={extraOpen} onOpenChange={setExtraOpen} className="mt-4">
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                className="flex items-center gap-2 h-auto p-0 rounded-none hover:bg-transparent font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost hover:text-warm-faint uppercase"
              />
            }
          >
            {extraOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            more metadata
          </CollapsibleTrigger>
          <CollapsibleContent>
            <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 font-mono text-[length:var(--text-chrome)] text-warm-ghost">
              {extraEntries.map(([k, v]) => (
                <ExtraRow key={k} name={k} value={v} />
              ))}
            </dl>
          </CollapsibleContent>
        </Collapsible>
      )}
    </header>
  );
}

function ExtraRow({ name, value }: { name: string; value: unknown }) {
  return (
    <>
      <dt className="text-gold-muted tracking-[0.08em]">{name}</dt>
      <dd className="text-warm-faint">{formatValue(value)}</dd>
    </>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
