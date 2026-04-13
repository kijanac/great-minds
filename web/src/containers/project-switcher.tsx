import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, Check, Plus, Settings } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  useActiveBrainId,
  useBrains,
  useCreateBrain,
  useSwitchBrain,
} from "@/hooks/use-brain";

const ITEM_CLASS =
  "font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint hover:text-warm hover:bg-ink-raised rounded-sm gap-2 flex-1 justify-start";

export function ProjectSwitcher() {
  const navigate = useNavigate();
  const { data: brains, isLoading } = useBrains();
  const activeBrainId = useActiveBrainId();
  const switchBrain = useSwitchBrain();
  const createBrain = useCreateBrain();

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  useEffect(() => {
    if (!open) {
      setCreating(false);
      setName("");
    }
  }, [open]);

  if (isLoading) return null;

  const list = brains ?? [];
  const isEmpty = list.length === 0;
  const Icon = isEmpty ? Plus : ArrowLeftRight;
  const triggerLabel = isEmpty ? "new project" : "switch project";

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    await createBrain.mutateAsync(trimmed);
    setName("");
    setCreating(false);
    setOpen(false);
    navigate("/");
  }

  function handleSwitch(brainId: string) {
    if (brainId !== activeBrainId) {
      switchBrain(brainId);
      navigate("/");
    }
    setOpen(false);
  }

  function handleSettings(brainId: string) {
    setOpen(false);
    navigate(`/project/${brainId}/settings`);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={triggerLabel}
            className="text-warm-ghost hover:text-warm-faint hover:bg-ink-raised rounded-sm"
          />
        }
      >
        <Icon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-auto min-w-[220px] p-1 rounded-sm bg-ink-panel border-ink-border"
      >
        {isEmpty ? (
          <form onSubmit={handleCreate} className="px-2 py-1.5">
            <input
              ref={inputRef}
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
              }}
              placeholder="project name"
              className="w-full bg-transparent font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm placeholder:text-warm-ghost outline-none border-b border-ink-border py-0.5"
            />
          </form>
        ) : (
          <>
            {list.map((brain) => {
              const isActive = brain.id === activeBrainId;
              return (
                <div key={brain.id} className="flex items-center group">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleSwitch(brain.id)}
                    className={ITEM_CLASS}
                  >
                    {isActive ? <Check className="size-3.5" /> : <span className="size-3.5" />}
                    {brain.name}
                  </Button>
                  {isActive && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleSettings(brain.id)}
                      aria-label="project settings"
                      className="text-warm-ghost hover:text-gold hover:bg-transparent opacity-0 group-hover:opacity-100 transition-opacity mr-1"
                    >
                      <Settings size={11} />
                    </Button>
                  )}
                </div>
              );
            })}
            <div className="my-1 border-t border-ink-border" />
            {creating ? (
              <form onSubmit={handleCreate} className="px-2 py-1">
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
                className={`${ITEM_CLASS} w-full`}
              >
                <Plus className="size-3.5" />
                new project
              </Button>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
