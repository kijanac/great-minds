import { useState } from "react";
import { Home, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { SessionSummary } from "@/api/sessions";

interface SessionListProps {
  sessions: SessionSummary[];
  loading: boolean;
  onSessionClick: (id: string) => void;
  onHome: () => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function SessionList({ sessions, loading, onSessionClick, onHome }: SessionListProps) {
  const [filter, setFilter] = useState("");

  const filtered = filter.trim()
    ? sessions.filter((s) => {
        const q = filter.toLowerCase();
        return s.query.toLowerCase().includes(q);
      })
    : sessions;

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <div className="shrink-0 flex items-center justify-between px-4 md:px-6 pt-4 pb-3 border-b border-ink-subtle gap-3">
        <div className="flex items-center gap-4 shrink-0">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onHome}
            className="text-muted-foreground hover:text-gold hover:bg-transparent"
          >
            <Home size={14} />
          </Button>
          <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase hidden md:inline">
            sessions
          </span>
        </div>

        <div className="flex items-center gap-2 max-w-[300px] w-full">
          <Search size={14} className="text-muted-foreground shrink-0" />
          <Input
            className="h-7 bg-transparent dark:bg-transparent border-ink-border rounded-sm font-serif text-[length:var(--text-small)] text-foreground px-3 caret-gold placeholder:text-input focus-visible:ring-0 focus-visible:border-gold-dim"
            placeholder="Filter..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[740px] mx-auto px-4 md:px-10 pt-8 pb-20">
          {loading && (
            <p className="text-[length:var(--text-body)] text-warm-faint animate-[pulse-fade_1.6s_ease-in-out_infinite]">
              Loading...
            </p>
          )}

          {!loading && filtered.length === 0 && filter && (
            <p className="text-[length:var(--text-body)] text-warm-faint">
              No sessions match your filter.
            </p>
          )}

          {!loading && filtered.length === 0 && !filter && (
            <div className="text-center pt-8">
              <p className="font-serif text-[length:var(--text-body)] text-warm-dim mb-2">
                No sessions yet
              </p>
              <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost mb-6">
                sessions are created when you ask a question from home
              </p>
              <Button
                variant="ghost"
                onClick={onHome}
                className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:text-gold hover:bg-transparent h-auto px-3 py-1.5"
              >
                go home →
              </Button>
            </div>
          )}

          {!loading &&
            filtered.map((s, i) => (
              <div key={s.id}>
                {i > 0 && <Separator className="my-4 bg-ink-subtle" />}
                <Button
                  variant="ghost"
                  onClick={() => onSessionClick(s.id)}
                  className="w-full h-auto py-3 px-3 rounded-sm justify-start hover:bg-ink-raised group flex-col items-start gap-1.5"
                >
                  <span className="font-serif italic text-[length:var(--text-body)] text-warm-dim group-hover:text-warm transition-colors truncate w-full text-left">
                    {s.query}
                  </span>
                  <span className="font-mono text-[length:var(--text-chrome)] text-muted-foreground flex items-center gap-3">
                    <span>{formatDate(s.updated)}</span>
                  </span>
                </Button>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
