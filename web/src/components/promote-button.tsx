import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { promoteExchange, type PromoteResult } from "@/api/sessions";

interface PromoteButtonProps {
  sessionId: string;
  exchangeId: string;
}

type State =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "done"; result: PromoteResult }
  | { kind: "error"; message: string };

export function PromoteButton({ sessionId, exchangeId }: PromoteButtonProps) {
  const [state, setState] = useState<State>({ kind: "idle" });

  const onClick = useCallback(async () => {
    setState({ kind: "pending" });
    try {
      const result = await promoteExchange(sessionId, exchangeId);
      setState({ kind: "done", result });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to promote";
      setState({ kind: "error", message });
    }
  }, [sessionId, exchangeId]);

  if (state.kind === "done") {
    const { result } = state;
    const label =
      result.mode === "ingested"
        ? `saved as "${result.title}"`
        : `submitted for review`;
    return (
      <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint">
        {label}
      </span>
    );
  }

  if (state.kind === "error") {
    return (
      <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-destructive">
        {state.message}
      </span>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={state.kind === "pending"}
      className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost hover:text-warm-faint hover:bg-transparent h-auto px-2 py-1"
    >
      {state.kind === "pending" ? "saving…" : "save as source"}
    </Button>
  );
}
