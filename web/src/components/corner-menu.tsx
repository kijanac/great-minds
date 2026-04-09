import { useState, useRef, useEffect } from "react";
import { Check, LogOut, Moon, Plus, Settings, SettingsIcon, Sun } from "lucide-react";

import type { BrainOverview } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface CornerMenuProps {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onSignOut: () => void;
  brains: BrainOverview[];
  activeBrainId: string | null;
  onSwitchBrain: (brainId: string) => void;
  onCreateBrain: (name: string) => Promise<void>;
  onProjectSettings: (brainId: string) => void;
}

const menuItemClass =
  "font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint hover:text-warm hover:bg-ink-raised rounded-sm gap-2 w-full justify-start";

export function CornerMenu({
  theme,
  onToggleTheme,
  onSignOut,
  brains,
  activeBrainId,
  onSwitchBrain,
  onCreateBrain,
  onProjectSettings,
}: CornerMenuProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    await onCreateBrain(trimmed);
    setName("");
    setCreating(false);
  }

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
        <div className="px-2 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost select-none">
          projects
        </div>
        {brains.map((brain) => {
          const isActive = brain.id === activeBrainId;
          return (
            <div key={brain.id} className="flex items-center group">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSwitchBrain(brain.id)}
                className={`${menuItemClass} flex-1`}
              >
                {isActive ? (
                  <Check className="size-3.5" />
                ) : (
                  <span className="size-3.5" />
                )}
                {brain.name}
              </Button>
              {isActive && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onProjectSettings(brain.id)}
                  className="text-warm-ghost hover:text-gold hover:bg-transparent opacity-0 group-hover:opacity-100 transition-opacity mr-1"
                >
                  <SettingsIcon size={11} />
                </Button>
              )}
            </div>
          );
        })}
        {creating ? (
          <form onSubmit={handleSubmit} className="px-2 py-1">
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setCreating(false);
                  setName("");
                }
              }}
              placeholder="project name"
              className="w-full bg-transparent font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm placeholder:text-warm-ghost outline-none border-b border-ink-border py-0.5"
            />
          </form>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCreating(true)}
            className={menuItemClass}
          >
            <Plus className="size-3.5" />
            new project
          </Button>
        )}
        <div className="my-1 border-t border-ink-border" />
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
