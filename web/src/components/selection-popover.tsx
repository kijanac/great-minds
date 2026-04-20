import { Button } from "@/components/ui/button";
import type { SelectionInfo } from "@/lib/types";

interface SelectionPopoverProps {
  info: SelectionInfo;
  onFollowUp?: () => void;
  onBtw: () => void;
  onSuggest?: () => void;
}

export function SelectionPopover({
  info,
  onFollowUp,
  onBtw,
  onSuggest,
}: SelectionPopoverProps) {
  return (
    <div
      data-popover
      className="fixed z-[300] bg-popover border border-gold-dim rounded-sm flex overflow-hidden shadow-[0_6px_24px_rgba(80,60,30,0.18)] dark:shadow-[0_6px_24px_rgba(0,0,0,0.7)] animate-[pop-in_0.14s_ease_forwards] -mt-1.5"
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
        className={`rounded-none h-auto text-btw font-mono text-[length:var(--text-chrome)] tracking-[0.1em] py-[9px] px-3.5 hover:text-btw-bright hover:bg-btw-bg ${onFollowUp ? "border-l border-gold-dim" : ""}`}
      >
        btw
      </Button>
      {onSuggest && (
        <Button
          variant="ghost"
          size="sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onSuggest}
          className="rounded-none h-auto text-gold-muted font-mono text-[length:var(--text-chrome)] tracking-[0.1em] py-[9px] px-3.5 hover:text-gold hover:bg-interactive-dim border-l border-gold-dim"
        >
          suggest
        </Button>
      )}
    </div>
  );
}
