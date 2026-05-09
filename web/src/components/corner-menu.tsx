import { LogOut, Moon, Settings, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface CornerMenuProps {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onSignOut: () => void;
}

export function CornerMenu({ theme, onToggleTheme, onSignOut }: CornerMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="settings"
            className="text-warm-ghost hover:text-warm-faint hover:bg-ink-raised rounded-sm"
          />
        }
      >
        <Settings className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-auto min-w-0 p-1 rounded-sm"
      >
        <DropdownMenuItem
          onClick={onToggleTheme}
          className="text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint gap-2 cursor-pointer"
        >
          {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
          {theme === "dark" ? "light mode" : "dark mode"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={onSignOut}
          className="text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint gap-2 cursor-pointer"
        >
          <LogOut className="size-3.5" />
          sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
