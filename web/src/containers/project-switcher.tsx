import { useState } from "react";
import { ArrowLeftRight, Check, Plus, Settings } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  useActiveVaultId,
  useVaults,
  useSwitchVault,
} from "@/hooks/use-vault";

const ITEM_CLASS =
  "font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint hover:text-warm hover:bg-ink-raised rounded-sm gap-2 flex-1 justify-start";

export function ProjectSwitcher() {
  const navigate = useNavigate();
  const { data: vaults, isLoading } = useVaults();
  const activeVaultId = useActiveVaultId();
  const switchVault = useSwitchVault();

  const [open, setOpen] = useState(false);

  if (isLoading) return null;

  const list = vaults ?? [];
  const isEmpty = list.length === 0;
  const Icon = isEmpty ? Plus : ArrowLeftRight;
  const triggerLabel = isEmpty ? "new project" : "switch project";

  function handleCreate() {
    setOpen(false);
    navigate("/vaults/new");
  }

  function handleSwitch(vaultId: string) {
    if (vaultId !== activeVaultId) {
      switchVault(vaultId);
      navigate("/");
    }
    setOpen(false);
  }

  function handleSettings(vaultId: string) {
    setOpen(false);
    navigate(`/project/${vaultId}/settings`);
  }

  if (isEmpty) {
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={triggerLabel}
        onClick={handleCreate}
        className="text-warm-ghost hover:text-warm-faint hover:bg-ink-raised rounded-sm"
      >
        <Icon className="size-3.5" />
      </Button>
    );
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
        {list.map((vault) => {
          const isActive = vault.id === activeVaultId;
          return (
            <div key={vault.id} className="flex items-center group">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleSwitch(vault.id)}
                className={ITEM_CLASS}
              >
                {isActive ? <Check className="size-3.5" /> : <span className="size-3.5" />}
                {vault.name}
              </Button>
              {isActive && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => handleSettings(vault.id)}
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
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCreate}
          className={`${ITEM_CLASS} w-full`}
        >
          <Plus className="size-3.5" />
          new project
        </Button>
      </PopoverContent>
    </Popover>
  );
}
