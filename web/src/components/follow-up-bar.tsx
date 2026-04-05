import { useState } from "react"
import { X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface FollowUpBarProps {
  chips: string[]
  onRemoveChip: (index: number) => void
  onSubmit: (text: string) => void
}

export function FollowUpBar({ chips, onRemoveChip, onSubmit }: FollowUpBarProps) {
  const [input, setInput] = useState("")

  const handleSubmit = () => {
    if (chips.length === 0 && !input.trim()) return
    onSubmit(input.trim())
    setInput("")
  }

  return (
    <div className="shrink-0 border-t border-ink-subtle px-10 pt-3 pb-3.5 flex flex-col gap-2 animate-[slide-up_0.28s_cubic-bezier(0.4,0,0.2,1)]">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-[5px]">
          {chips.map((chip, i) => (
            <Badge
              key={i}
              variant="outline"
              className="rounded-sm h-auto bg-interactive-dim border-gold-dim py-1 pl-[11px] pr-[9px] italic text-[length:var(--text-caption)] text-warm-ghost flex items-center gap-[7px] max-w-[280px]"
            >
              <span className="overflow-hidden text-ellipsis whitespace-nowrap flex-1">
                {`"${chip.length > 42 ? chip.slice(0, 42) + "..." : chip}"`}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onRemoveChip(i)}
                className="p-0 h-auto w-auto text-gold-dim text-[length:var(--text-small)] hover:text-gold-muted hover:bg-transparent"
              >
                <X size={12} />
              </Button>
            </Badge>
          ))}
        </div>
      )}

      <div className="flex items-center">
        <Input
          className="flex-1 h-auto bg-transparent border-none rounded-none text-warm-dim font-serif text-[length:var(--text-small)] py-[3px] px-0 caret-gold placeholder:text-interactive-dim focus-visible:ring-0"
          placeholder={
            chips.length > 0
              ? "add context or submit selections..."
              : "follow up..."
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit()
          }}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={handleSubmit}
          disabled={chips.length === 0 && !input.trim()}
          className="rounded-sm border-ink-border text-muted-foreground font-mono text-[length:var(--text-chrome)] tracking-[0.1em] py-[7px] px-[13px] h-auto ml-3.5 hover:border-gold-dim hover:text-gold disabled:opacity-25"
        >
          FOLLOW UP
        </Button>
      </div>
    </div>
  )
}
