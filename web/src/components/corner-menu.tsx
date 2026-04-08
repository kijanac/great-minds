import { LogOut, Moon, Settings, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface CornerMenuProps {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onSignOut: () => void;
}

const menuItemClass =
  "font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint hover:text-warm hover:bg-ink-raised rounded-sm gap-2 w-full justify-start";

export function CornerMenu({ theme, onToggleTheme, onSignOut }: CornerMenuProps) {
  return (
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
        <Button variant="ghost" size="sm" onClick={onToggleTheme} className={menuItemClass}>
          {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
          {theme === "dark" ? "light mode" : "dark mode"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onSignOut} className={menuItemClass}>
          <LogOut className="size-3.5" />
          sign out
        </Button>
      </PopoverContent>
    </Popover>
  );
}
