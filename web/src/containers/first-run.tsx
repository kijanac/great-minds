import { useState } from "react";

import { Input } from "@/components/ui/input";
import { useCreateBrain } from "@/hooks/use-brain";

export function FirstRun() {
  const createBrain = useCreateBrain();
  const [name, setName] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || createBrain.isPending) return;
    try {
      await createBrain.mutateAsync(trimmed);
    } catch {
      // mutation error state is exposed via createBrain.error if we need it later
    }
  }

  return (
    <div className="flex h-screen items-center justify-center px-4 md:px-10 pb-12">
      <div className="w-full max-w-[560px]">
        <h1 className="font-serif text-[length:var(--text-title)] text-foreground text-center leading-[1.15] mb-2">
          Name your first project
        </h1>
        <p className="text-center font-mono text-[length:var(--text-caption)] tracking-[0.1em] text-warm-ghost mb-8">
          a library of sources you can ask across
        </p>

        <form onSubmit={handleSubmit}>
          <div className="w-full flex items-center bg-secondary border border-input focus-within:border-ring rounded-sm overflow-hidden">
            <Input
              autoFocus
              disabled={createBrain.isPending}
              className="flex-1 h-auto border-none rounded-none bg-transparent dark:bg-transparent font-serif text-[length:var(--text-body)] text-foreground px-[18px] py-[13px] caret-gold placeholder:text-input focus-visible:ring-0 focus-visible:border-none disabled:opacity-60"
              placeholder="untitled"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {name.trim() && (
              <span className="pr-4 font-mono text-[length:var(--text-chrome)] text-warm-ghost select-none">
                ↵
              </span>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
