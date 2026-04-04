import { useState } from "react"

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
    <div className="shrink-0 border-t border-[#161616] px-10 pt-3 pb-3.5 flex flex-col gap-2 animate-[slide-up_0.28s_cubic-bezier(0.4,0,0.2,1)]">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-[5px]">
          {chips.map((chip, i) => (
            <Badge
              key={i}
              variant="outline"
              className="rounded-sm h-auto bg-[#100e08] border-[#3a2810] py-1 pl-[11px] pr-[9px] italic text-[11px] text-[#7a6848] flex items-center gap-[7px] max-w-[280px]"
            >
              <span className="overflow-hidden text-ellipsis whitespace-nowrap flex-1">
                &ldquo;{chip.length > 42 ? chip.slice(0, 42) + "..." : chip}&rdquo;
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onRemoveChip(i)}
                className="p-0 h-auto w-auto text-[#3a2810] text-[13px] hover:text-[#9a7040] hover:bg-transparent"
              >
                &times;
              </Button>
            </Badge>
          ))}
        </div>
      )}

      <div className="flex items-center">
        <Input
          className="flex-1 h-auto bg-transparent border-none rounded-none text-[#c0b8a8] font-serif text-[13.5px] py-[3px] px-0 caret-gold placeholder:text-[#221a0e] focus-visible:ring-0"
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
          className="rounded-sm border-[#1e1810] text-[#5a4e38] font-mono text-[8.5px] tracking-[0.1em] py-[7px] px-[13px] h-auto ml-3.5 hover:border-gold-dim hover:text-gold disabled:opacity-25"
        >
          FOLLOW UP
        </Button>
      </div>
    </div>
  )
}
