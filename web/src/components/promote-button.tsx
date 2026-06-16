import { useCallback, useRef, useState } from "react";
import { FilePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { promoteExchange, type PromoteResult } from "@/api/sessions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { POPOVER_SURFACE_CLASS } from "@/lib/control-styles";

interface PromoteButtonProps {
  sessionId: string;
  exchangeId: string;
  onPreviewChange?: (exchangeId: string, previewing: boolean) => void;
}

type State =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "done"; result: PromoteResult }
  | { kind: "error"; message: string };

export function PromoteButton({ sessionId, exchangeId, onPreviewChange }: PromoteButtonProps) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const hoveringRef = useRef(false);
  const focusedRef = useRef(false);
  const openRef = useRef(false);

  const updatePreview = useCallback(
    (next: { hovering?: boolean; focused?: boolean; open?: boolean }) => {
      if (next.hovering !== undefined) hoveringRef.current = next.hovering;
      if (next.focused !== undefined) focusedRef.current = next.focused;
      if (next.open !== undefined) openRef.current = next.open;
      onPreviewChange?.(exchangeId, hoveringRef.current || focusedRef.current || openRef.current);
    },
    [exchangeId, onPreviewChange],
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (state.kind === "pending") return;
      updatePreview({ open });
      setConfirmOpen(open);
    },
    [state.kind, updatePreview],
  );

  const onConfirm = useCallback(async () => {
    setState({ kind: "pending" });
    try {
      const result = await promoteExchange(sessionId, exchangeId);
      updatePreview({ hovering: false, focused: false, open: false });
      setConfirmOpen(false);
      setState({ kind: "done", result });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to promote";
      updatePreview({ hovering: false, focused: false, open: false });
      setConfirmOpen(false);
      setState({ kind: "error", message });
    }
  }, [sessionId, exchangeId, updatePreview]);

  if (state.kind === "done") {
    const { result } = state;
    const label =
      result.mode === "ingested"
        ? result.title?.trim()
          ? `saved as "${result.title}"`
          : "saved as source"
        : "submitted for review";
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
    <span
      className="inline-flex"
      onMouseEnter={() => updatePreview({ hovering: true })}
      onMouseLeave={() => updatePreview({ hovering: false })}
      onFocus={() => updatePreview({ focused: true })}
      onBlur={() => updatePreview({ focused: false })}
    >
      <AlertDialog open={confirmOpen} onOpenChange={handleOpenChange}>
        <AlertDialogTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              disabled={state.kind === "pending"}
              className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost hover:text-gold hover:bg-gold/5 h-auto px-2 py-1 rounded-sm"
            />
          }
        >
          <FilePlus className="size-3" />
          {state.kind === "pending" ? "saving..." : "save as source"}
        </AlertDialogTrigger>
        <AlertDialogContent className={POPOVER_SURFACE_CLASS}>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-[length:var(--text-body)] text-warm">
              Save this exchange as a source?
            </AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost">
              Owners add this answer to sources and queue a compile. Other members submit it for
              review.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-sm border border-gold-dim/70 bg-gold/5 px-3 py-2">
            <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-gold-muted">
              raw/sessions/{exchangeId}.md
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={state.kind === "pending"}
              className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em]"
            >
              cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={state.kind === "pending"}
              onClick={(e) => {
                e.preventDefault();
                void onConfirm();
              }}
              className="font-mono text-[length:var(--text-chrome)] tracking-[0.08em] bg-gold/10 text-gold hover:bg-gold/20 border border-gold-dim disabled:opacity-40"
            >
              {state.kind === "pending" ? "saving..." : "save source"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  );
}
