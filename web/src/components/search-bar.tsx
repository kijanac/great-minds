import { useRef, useEffect } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Phase } from "@/lib/types"

interface SearchBarProps {
  query: string
  phase: Phase
  onQueryChange: (query: string) => void
  onSubmit: () => void
  onReset: () => void
}

export function SearchBar({
  query,
  phase,
  onQueryChange,
  onSubmit,
  onReset,
}: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const isActive = phase !== "idle"

  useEffect(() => {
    if (!isActive) inputRef.current?.focus()
  }, [isActive])

  return (
    <div
      className={`w-full flex items-center bg-secondary border border-input rounded-sm overflow-hidden focus-within:border-ring ${
        isActive ? "" : "max-w-[640px]"
      }`}
    >
      <Input
        ref={inputRef}
        className="flex-1 h-auto border-none rounded-none bg-transparent font-serif text-[length:var(--text-body)] text-foreground px-[18px] py-[13px] caret-gold placeholder:text-input focus-visible:ring-0 focus-visible:border-none"
        placeholder="Ask a question across the knowledge base..."
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
        disabled={isActive}
        autoFocus={!isActive}
      />

      {isActive ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          className="rounded-none font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-muted-foreground px-3 py-[13px] h-auto hover:text-warm-faint hover:bg-transparent"
        >
          clear
        </Button>
      ) : (
        <Button
          onClick={onSubmit}
          disabled={!query.trim()}
          className="rounded-none h-auto bg-gold text-ink font-mono text-[length:var(--text-chrome)] font-medium tracking-[0.12em] px-[18px] py-[13px] hover:bg-gold-hover disabled:bg-interactive-ghost disabled:text-muted-foreground disabled:opacity-100"
        >
          QUERY
        </Button>
      )}
    </div>
  )
}
