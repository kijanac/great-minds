import { useState, useCallback } from "react"
import { Home, Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface ArticleChromeProps {
  slug: string
  onHome: () => void
  onQuery: (question: string) => void
  onContentClick?: React.MouseEventHandler
  children: React.ReactNode
}

export function ArticleChrome({
  slug,
  onHome,
  onQuery,
  onContentClick,
  children,
}: ArticleChromeProps) {
  const [queryExpanded, setQueryExpanded] = useState(false)
  const [queryText, setQueryText] = useState("")

  const handleSubmit = useCallback(() => {
    if (!queryText.trim()) return
    onQuery(queryText.trim())
  }, [queryText, onQuery])

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <div className="shrink-0 flex items-center justify-between px-6 pt-4 pb-3 border-b border-ink-subtle">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onHome}
            className="text-muted-foreground hover:text-gold hover:bg-transparent"
          >
            <Home size={14} />
          </Button>
          <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase">
            {slug}
          </span>
        </div>

        {queryExpanded ? (
          <div className="flex items-center gap-2 max-w-[400px] w-full">
            <Input
              className="h-7 bg-transparent border-ink-border rounded-sm font-serif text-[length:var(--text-small)] text-foreground px-3 caret-gold placeholder:text-input focus-visible:ring-0 focus-visible:border-gold-dim"
              placeholder="Ask a question..."
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit()
                if (e.key === "Escape") {
                  setQueryExpanded(false)
                  setQueryText("")
                }
              }}
              autoFocus
            />
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                setQueryExpanded(false)
                setQueryText("")
              }}
              className="text-muted-foreground hover:text-warm-faint hover:bg-transparent shrink-0"
            >
              <X size={12} />
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setQueryExpanded(true)}
            className="text-muted-foreground hover:text-gold hover:bg-transparent"
          >
            <Search size={14} />
          </Button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" onClick={onContentClick}>{children}</div>
    </div>
  )
}
