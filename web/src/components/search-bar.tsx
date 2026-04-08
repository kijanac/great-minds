import { useRef, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SessionSummary } from "@/api/sessions";
import type { Phase } from "@/lib/types";
import { formatRelativeDate } from "@/lib/utils";

interface SearchBarProps {
  query: string;
  phase: Phase;
  onQueryChange: (query: string) => void;
  onSubmit: () => void;
  onReset: () => void;
  recentSessions?: SessionSummary[];
  sessionsLoading?: boolean;
  onSessionClick?: (id: string) => void;
  onViewAllSessions?: () => void;
}

export function SearchBar({
  query,
  phase,
  onQueryChange,
  onSubmit,
  onReset,
  recentSessions,
  sessionsLoading,
  onSessionClick,
  onViewAllSessions,
}: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isActive = phase !== "idle";
  const [focused, setFocused] = useState(false);

  const showDropdown =
    focused &&
    !isActive &&
    !sessionsLoading &&
    !query.trim() &&
    recentSessions &&
    recentSessions.length > 0;

  useEffect(() => {
    if (!isActive) inputRef.current?.focus();
  }, [isActive]);

  return (
    <div className={`relative w-full ${isActive ? "" : "max-w-[640px]"}`}>
      <div
        className={`w-full flex items-center bg-secondary border border-input focus-within:border-ring overflow-hidden ${showDropdown ? "rounded-t-sm rounded-b-none border-b-transparent" : "rounded-sm"}`}
      >
        <Input
          ref={inputRef}
          className="flex-1 h-auto border-none rounded-none bg-transparent dark:bg-transparent font-serif text-[length:var(--text-body)] text-foreground px-[18px] py-[13px] caret-gold placeholder:text-input focus-visible:ring-0 focus-visible:border-none disabled:opacity-100"
          placeholder="Ask a question across the knowledge base..."
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit()}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          disabled={isActive}
          autoFocus={!isActive}
        />

        {isActive ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="rounded-none font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-muted-foreground px-3 py-[13px] h-auto hover:text-warm-faint hover:bg-transparent"
          >
            clear
          </Button>
        ) : (
          <Button
            onClick={onSubmit}
            disabled={!query.trim()}
            className="rounded-none h-auto bg-gold text-primary-foreground font-mono text-[length:var(--text-chrome)] font-medium tracking-[0.12em] px-[18px] py-[13px] hover:bg-gold-hover disabled:bg-interactive-ghost disabled:text-muted-foreground disabled:opacity-100"
          >
            QUERY
          </Button>
        )}
      </div>

      {showDropdown && (
        <div className="absolute left-0 right-0 top-full bg-secondary border border-input border-t-ink-subtle rounded-b-sm overflow-hidden z-50">
          {recentSessions.slice(0, 3).map((s) => (
            <button
              key={s.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setFocused(false);
                onSessionClick?.(s.id);
              }}
              className="group w-full flex items-center justify-between px-[18px] py-2.5 hover:bg-ink-raised focus-visible:bg-ink-raised focus-visible:outline-none transition-colors text-left"
            >
              <span className="font-serif italic text-[length:var(--text-small)] text-warm-dim group-hover:text-warm truncate">
                {s.query}
              </span>
              <span className="font-mono text-[length:var(--text-chrome)] text-muted-foreground shrink-0 ml-3">
                {formatRelativeDate(s.updated)}
              </span>
            </button>
          ))}
          {onViewAllSessions && (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setFocused(false);
                onViewAllSessions();
              }}
              className="w-full px-[18px] py-2 border-t border-ink-subtle font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-muted-foreground hover:text-gold focus-visible:text-gold focus-visible:outline-none transition-colors text-left"
            >
              all sessions
            </button>
          )}
        </div>
      )}
    </div>
  );
}
