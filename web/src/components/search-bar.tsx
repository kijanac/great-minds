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
      className={`shrink-0 flex flex-col items-center px-10 transition-all duration-[440ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
        isActive
          ? "pt-[22px] pb-[18px] border-b border-ink-subtle"
          : "flex-1 justify-center pb-[72px]"
      }`}
    >
      {!isActive && (
        <div className="font-mono text-[9.5px] tracking-[0.26em] uppercase text-gold-muted mb-10">
          ARCHIVE — KNOWLEDGE BASE
        </div>
      )}

      <div
        className={`w-full flex items-center bg-secondary border border-input rounded-sm overflow-hidden transition-[max-width] duration-400 ease-[cubic-bezier(0.4,0,0.2,1)] focus-within:border-ring ${
          isActive ? "max-w-full" : "max-w-[640px]"
        }`}
      >
        <Input
          ref={inputRef}
          className="flex-1 h-auto border-none rounded-none bg-transparent font-serif text-[14.5px] text-foreground px-[18px] py-[13px] caret-gold placeholder:text-input focus-visible:ring-0 focus-visible:border-none"
          placeholder="Ask a question across the knowledge base..."
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit()}
          disabled={isActive}
          autoFocus
        />

        {isActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="rounded-none font-mono text-[9.5px] tracking-[0.08em] text-muted-foreground px-3 py-[13px] h-auto hover:text-warm-faint hover:bg-transparent"
          >
            clear
          </Button>
        )}

        <Button
          onClick={onSubmit}
          disabled={isActive || !query.trim()}
          className="rounded-none h-auto bg-gold text-ink font-mono text-[9.5px] font-medium tracking-[0.12em] px-[18px] py-[13px] hover:bg-[#dbbf84] disabled:bg-[#1a1a1a] disabled:text-[#2a2a2a] disabled:opacity-100"
        >
          {isActive ? "WORKING" : "QUERY"}
        </Button>
      </div>

      {!isActive && (
        <div className="font-mono text-[9px] tracking-[0.14em] text-[#221a10] mt-4">
          return to submit · select text to follow up or digress
        </div>
      )}
    </div>
  )
}
