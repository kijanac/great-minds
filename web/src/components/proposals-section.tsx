import { useState } from "react";
import { Check, X } from "lucide-react";

import type { ProposalOverview } from "@/api/proposals";
import type { ProposalFilter } from "@/containers/proposals-section-container";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CHIP_ACTIVE, CHIP_BASE, CHIP_INACTIVE } from "@/lib/chip";
import { cn, formatShortDate } from "@/lib/utils";

const STATUS_FILTERS: { value: ProposalFilter; label: string }[] = [
  { value: "pending", label: "pending" },
  { value: "approved", label: "approved" },
  { value: "rejected", label: "rejected" },
  { value: "all", label: "all" },
];

interface ProposalsSectionProps {
  proposals: ProposalOverview[];
  loading: boolean;
  hasMore: boolean;
  isOwner: boolean;
  activeStatus: ProposalFilter;
  creating: boolean;
  reviewing: boolean;
  onStatusFilter: (status: ProposalFilter) => void;
  onCreate: (input: {
    content: string;
    content_type: string;
    title?: string;
    author?: string;
  }) => Promise<void>;
  onReview: (proposalId: string, status: "approved" | "rejected") => Promise<void>;
  onLoadMore: () => void;
}

const TEXTAREA_CLASS =
  "w-full bg-secondary border border-input focus-within:border-ring rounded-sm px-[14px] py-[10px] font-serif text-[length:var(--text-body)] text-foreground placeholder:text-warm-ghost outline-none resize-y min-h-[120px] caret-gold";

export function ProposalsSection({
  proposals,
  loading,
  hasMore,
  isOwner,
  activeStatus,
  creating,
  reviewing,
  onStatusFilter,
  onCreate,
  onReview,
  onLoadMore,
}: ProposalsSectionProps) {
  const [showSubmit, setShowSubmit] = useState(false);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [contentType, setContentType] = useState("texts");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || creating) return;
    await onCreate({
      content: trimmed,
      content_type: contentType,
      title: title.trim() || undefined,
      author: author.trim() || undefined,
    });
    setContent("");
    setTitle("");
    setAuthor("");
    setShowSubmit(false);
  }

  return (
    <div className="mt-12">
      <h2 className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase mb-4">
        proposals
      </h2>

      <div className="flex flex-wrap gap-2 mb-4">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => onStatusFilter(f.value)}
            className={cn(CHIP_BASE, activeStatus === f.value ? CHIP_ACTIVE : CHIP_INACTIVE)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && proposals.length === 0 ? (
        <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost">
          loading…
        </p>
      ) : proposals.length === 0 ? (
        <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost mb-4">
          no proposals
        </p>
      ) : (
        <div className="space-y-1 mb-4">
          {proposals.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between py-2 px-3 rounded-sm hover:bg-ink-raised group"
            >
              <div className="flex flex-col items-start gap-0.5 min-w-0 flex-1">
                <span className="font-serif text-[length:var(--text-body)] text-warm-dim group-hover:text-warm transition-colors truncate w-full text-left">
                  {p.title || "(untitled)"}
                </span>
                <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost truncate w-full text-left">
                  {p.content_type} · {p.status}
                </span>
              </div>
              <div className="flex items-center gap-3 shrink-0 ml-4">
                <span className="font-mono text-[length:var(--text-chrome)] text-warm-ghost">
                  {formatShortDate(p.created_at)}
                </span>
                {isOwner && p.status === "pending" && (
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => onReview(p.id, "approved")}
                      disabled={reviewing}
                      aria-label="approve"
                      className="text-warm-ghost hover:text-gold hover:bg-transparent"
                    >
                      <Check size={12} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => onReview(p.id, "rejected")}
                      disabled={reviewing}
                      aria-label="reject"
                      className="text-warm-ghost hover:text-red-400 hover:bg-transparent"
                    >
                      <X size={12} />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {hasMore && !loading && (
        <div className="mb-4 text-center">
          <Button
            variant="ghost"
            onClick={onLoadMore}
            className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:text-gold hover:bg-transparent h-auto px-3 py-1.5"
          >
            load more
          </Button>
        </div>
      )}

      {showSubmit ? (
        <form onSubmit={handleSubmit} className="space-y-3 mt-4">
          <div className="flex gap-3">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="title (optional)"
              disabled={creating}
              className="h-8 flex-1 bg-transparent dark:bg-transparent border-ink-border rounded-sm font-mono text-[length:var(--text-small)] text-warm px-3 caret-gold placeholder:text-warm-ghost focus-visible:ring-0 focus-visible:border-gold-dim"
            />
            <Input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="author (optional)"
              disabled={creating}
              className="h-8 flex-1 bg-transparent dark:bg-transparent border-ink-border rounded-sm font-mono text-[length:var(--text-small)] text-warm px-3 caret-gold placeholder:text-warm-ghost focus-visible:ring-0 focus-visible:border-gold-dim"
            />
            <select
              value={contentType}
              onChange={(e) => setContentType(e.target.value)}
              disabled={creating}
              className="h-8 bg-transparent border border-ink-border rounded-sm font-mono text-[length:var(--text-small)] text-warm px-3 focus:outline-none focus:border-gold-dim"
            >
              <option value="texts">texts</option>
              <option value="news">news</option>
              <option value="ideas">ideas</option>
            </select>
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="paste source content here"
            disabled={creating}
            rows={6}
            className={TEXTAREA_CLASS}
          />
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              disabled={!content.trim() || creating}
              className="rounded-sm bg-gold/15 text-gold border border-gold-dim hover:bg-gold/25 font-mono text-[length:var(--text-chrome)] tracking-[0.1em]"
            >
              {creating ? "submitting…" : "submit proposal"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowSubmit(false)}
              disabled={creating}
              className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost hover:text-warm hover:bg-transparent"
            >
              cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="ghost"
          onClick={() => setShowSubmit(true)}
          className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint hover:text-gold hover:bg-transparent"
        >
          + propose a source
        </Button>
      )}
    </div>
  );
}
