import { useState } from "react";
import { Check, X } from "lucide-react";

import type { ProposalOverview } from "@/api/proposals";
import type { ProposalFilter } from "@/containers/proposals-section-container";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  FILTER_CHIP_CLASS,
  SELECT_CONTENT_CLASS,
  SELECT_ITEM_CLASS,
  SELECT_TRIGGER_CLASS,
} from "@/lib/control-styles";
import { formatShortDate } from "@/lib/utils";

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

      <ToggleGroup
        multiple={false}
        value={[activeStatus]}
        onValueChange={(vals) => vals[0] && onStatusFilter(vals[0] as ProposalFilter)}
        variant="outline"
        size="sm"
        className="mb-4"
      >
        {STATUS_FILTERS.map((f) => (
          <ToggleGroupItem key={f.value} value={f.value} className={FILTER_CHIP_CLASS}>
            {f.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

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
                  {proposalTypeLabel(p.content_type)} · {p.status}
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
            <Select
              value={contentType}
              onValueChange={(val) => val && setContentType(val)}
              disabled={creating}
            >
              <SelectTrigger size="sm" className={`h-8 ${SELECT_TRIGGER_CLASS}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={SELECT_CONTENT_CLASS}>
                <SelectItem value="texts" className={SELECT_ITEM_CLASS}>
                  texts
                </SelectItem>
                <SelectItem value="news" className={SELECT_ITEM_CLASS}>
                  news
                </SelectItem>
                <SelectItem value="ideas" className={SELECT_ITEM_CLASS}>
                  ideas
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="paste source content here"
            disabled={creating}
            rows={6}
            className="rounded-sm font-serif text-[length:var(--text-body)] text-foreground placeholder:text-warm-ghost min-h-[120px] caret-gold focus-visible:ring-0"
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

function proposalTypeLabel(contentType: string): string {
  return contentType === "source_deletion" ? "delete source" : contentType;
}
