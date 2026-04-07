import { Button } from "@/components/ui/button"
import type { SelectionInfo } from "@/lib/types"

interface SelectionPopoverProps {
  info: SelectionInfo
  onFollowUp?: () => void
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
      className="fixed z-[300] bg-popover border border-gold-dim rounded-sm flex overflow-hidden shadow-[0_6px_24px_rgba(0,0,0,0.7)] animate-[pop-in_0.14s_ease_forwards] -mt-1.5"
      style={{ left: info.x, top: info.y }}
    >
      {onFollowUp && (
        <Button
          variant="ghost"
          size="sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onFollowUp}
          className="rounded-none h-auto text-popover-foreground font-mono text-[length:var(--text-chrome)] tracking-[0.1em] py-[9px] px-3.5 hover:bg-interactive-dim hover:text-gold"
        >
          + follow up
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onBtw}
        className={`rounded-none h-auto text-btw-green font-mono text-[length:var(--text-chrome)] tracking-[0.1em] py-[9px] px-3.5 hover:text-btw-green-bright hover:bg-btw-bg ${onFollowUp ? "border-l border-gold-dim" : ""}`}
      >
        btw
      </Button>
    </div>
  )
}
