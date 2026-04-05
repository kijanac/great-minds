import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { ThinkingBlock } from "@/lib/types"

interface ThinkingSectionProps {
  blocks: ThinkingBlock[]
  streaming: boolean
  onCardClick: (slug: string) => void
  activeCard: string | null
}

export function ThinkingSection({
  blocks,
  streaming,
  onCardClick,
  activeCard,
}: ThinkingSectionProps) {
  // null = user hasn't overridden, follow streaming state
  const [userOverride, setUserOverride] = useState<boolean | null>(null)
  const open = userOverride ?? streaming

  if (blocks.length === 0 && !streaming) return null

  const totalSources = blocks.reduce((n, b) => n + b.sources.length, 0)

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
          <span>
            {totalSources} source{totalSources !== 1 ? "s" : ""} traversed
          </span>
        )}
      </Button>

      {open && (
        <div className="mt-2 border-l-2 border-interactive-ghost pl-3.5 space-y-3">
          {blocks.map((block, i) => (
            <div key={i}>
              {block.text && (
                <p className="text-[length:var(--text-caption)] leading-[1.6] text-muted-foreground italic mb-1.5">
                  {block.text}
                </p>
              )}
              {block.sources.length > 0 && (
                <div className="flex flex-wrap gap-[5px]">
                  {block.sources.map((slug) => (
                    <Badge
                      key={slug}
                      variant="outline"
                      onClick={() => onCardClick(slug)}
                      className={`cursor-pointer rounded-sm h-auto px-[9px] py-[3px] font-mono text-[length:var(--text-chrome)] tracking-[0.06em] whitespace-nowrap transition-all ${
                        activeCard === slug
                          ? "border-gold-dim text-gold bg-interactive-dim"
                          : "bg-ink-raised border-ink-border text-card-foreground hover:border-gold-dim hover:text-gold"
                      }`}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e: React.KeyboardEvent) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          onCardClick(slug)
                        }
                      }}
                    >
                      {slug}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
