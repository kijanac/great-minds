import { LogOut, Settings } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

interface CornerMenuProps {
  onSignOut: () => void
}

export function CornerMenu({ onSignOut }: CornerMenuProps) {
  return (
    <div className="fixed bottom-4 left-4 z-50">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-warm-ghost hover:text-warm-faint hover:bg-ink-raised rounded-sm"
            />
          }
        >
          <Settings className="size-4" />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-auto min-w-0 p-1 rounded-sm bg-ink-panel border-ink-border"
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={onSignOut}
            className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint hover:text-warm hover:bg-ink-raised rounded-sm gap-2 w-full justify-start"
          >
            <LogOut className="size-3.5" />
            sign out
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  )
}
