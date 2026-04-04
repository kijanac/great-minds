import { Button } from "@/components/ui/button"
import type { SelectionInfo } from "@/lib/types"

interface SelectionPopoverProps {
  info: SelectionInfo
  onFollowUp: () => void
  onBtw: () => void
}

export function SelectionPopover({
  info,
  onFollowUp,
  onBtw,
}: SelectionPopoverProps) {
  return (
    <div
      data-popover
      className="fixed z-[300] -translate-x-1/2 -translate-y-full bg-popover border border-[#3a2810] rounded-sm flex overflow-hidden shadow-[0_6px_24px_rgba(0,0,0,0.7)] animate-[pop-in_0.14s_ease] -mt-1.5"
      style={{ left: info.x, top: info.y }}
    >
      <Button
        variant="ghost"
        size="sm"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onFollowUp}
        className="rounded-none h-auto text-popover-foreground font-mono text-[9px] tracking-[0.1em] py-[9px] px-3.5 hover:bg-[#221608] hover:text-gold"
      >
        + follow up
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onBtw}
        className="rounded-none h-auto text-btw-green font-mono text-[9px] tracking-[0.1em] py-[9px] px-3.5 border-l border-[#2a1e0e] hover:text-btw-green-bright hover:bg-[#0e1a0a]"
      >
        btw
      </Button>
    </div>
  )
}
