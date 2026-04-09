import { useState, useCallback } from "react";
import { Home } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ArticleChromeProps {
  label: string;
  onHome: () => void;
  onQuery: (question: string) => void;
  onContentClick?: React.MouseEventHandler;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function ArticleChrome({
  label,
  onHome,
  onQuery,
  onContentClick,
  footer,
  children,
}: ArticleChromeProps) {
  const [queryText, setQueryText] = useState("");

  const handleSubmit = useCallback(() => {
    if (!queryText.trim()) return;
    onQuery(queryText.trim());
    setQueryText("");
  }, [queryText, onQuery]);

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
            {label}
          </span>
        </div>

        <div className="flex items-center flex-1 max-w-[400px] bg-secondary border border-input rounded-sm overflow-hidden focus-within:border-ring">
          <Input
            className="flex-1 h-auto border-none rounded-none bg-transparent dark:bg-transparent font-serif text-[length:var(--text-small)] text-foreground px-3 py-[9px] caret-gold placeholder:text-input focus-visible:ring-0 focus-visible:border-none"
            placeholder="Ask about this article..."
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
              if (e.key === "Escape") {
                setQueryText("");
                e.currentTarget.blur();
              }
            }}
          />
          <Button
            onClick={handleSubmit}
            disabled={!queryText.trim()}
            className="rounded-none h-auto bg-gold text-primary-foreground font-mono text-[length:var(--text-chrome)] font-medium tracking-[0.12em] px-3 py-[9px] hover:bg-gold-hover disabled:bg-interactive-ghost disabled:text-muted-foreground disabled:opacity-100"
          >
            QUERY
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" onClick={onContentClick}>
        {children}
      </div>

      {footer}
    </div>
  );
}
