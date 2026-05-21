import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowLeft, ChevronDown } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import type { WikiArticleList } from "@/api/wiki";
import type { ProgressStep, StageProgress } from "@/hooks/use-job-sse";
import { useViewNavigate } from "@/hooks/use-view-navigate";

interface PipelinePageProps {
  stages: StageProgress[];
  overallDone: boolean;
  overallError: string | null;
  overallCancelled?: boolean;
  noJobFound?: boolean;
  connected?: boolean;
  /** Articles this run produced, fetched once the update finishes. Drives the
   *  completion card's "what you built" summary. */
  result?: WikiArticleList;
  onCancel?: () => void;
  onRetry?: () => void;
}

const EASE_OUT: [number, number, number, number] = [0.25, 1, 0.5, 1];

export function PipelinePage({
  stages,
  overallDone,
  overallError,
  overallCancelled,
  noJobFound,
  result,
  onCancel,
  onRetry,
}: PipelinePageProps) {
  const navigate = useViewNavigate();
  const prefersReducedMotion = useReducedMotion();
  const shouldAnimate = !prefersReducedMotion;
  const activeRef = useRef<HTMLDivElement>(null);

  const activeStageKey = useMemo(() => {
    const active = stages.find((s) => s.active);
    return active?.stage ?? null;
  }, [stages]);

  // Auto-scroll active stage into view (only when the active stage identity changes)
  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [activeStageKey]);

  const firstErrored = stages.find((s) => s.errored);
  const isRunning =
    !noJobFound && !overallDone && !overallError && !overallCancelled && stages.length > 0;

  // ---- Completion flourish ----
  const [showCompletion, setShowCompletion] = useState(false);
  useEffect(() => {
    const shouldShow = overallDone && !overallError;
    const t = setTimeout(() => setShowCompletion(shouldShow), shouldShow ? 300 : 0);
    return () => clearTimeout(t);
  }, [overallDone, overallError]);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 flex items-center px-4 md:px-6 pt-4 pb-3 border-b border-ink-subtle gap-4">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => navigate("/")}
          aria-label="back to home"
          className="text-muted-foreground hover:text-gold hover:bg-transparent"
        >
          <ArrowLeft size={14} />
        </Button>
        {isRunning && onCancel && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onCancel}
            className="ml-auto font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                       text-warm-ghost hover:text-red-400/90 hover:bg-transparent
                       rounded-sm h-auto px-3 py-1"
          >
            cancel
          </Button>
        )}
      </div>

      {/* Pipeline stages */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[640px] mx-auto px-4 md:px-10 pt-10 pb-20">
          {noJobFound && !overallError && (
            <div className="text-center pt-8">
              <p className="font-serif text-[length:var(--text-body)] text-warm-dim mb-2">
                No active job
              </p>
              <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost mb-5">
                drop sources from the home page to start a new ingest
              </p>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => navigate("/")}
                className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                           text-gold-dim hover:text-gold hover:bg-transparent
                           rounded-sm h-auto px-3 py-1"
              >
                back to home
              </Button>
            </div>
          )}

          {!noJobFound && stages.length === 0 && !overallError && (
            <div className="space-y-3">
              <Skeleton className="h-4 w-28 bg-ink-raised" />
              <Skeleton className="h-12 w-full bg-ink-raised" />
              <Skeleton className="h-12 w-5/6 bg-ink-raised" />
            </div>
          )}

          {overallError && (
            <Alert
              variant="destructive"
              className="mb-10 rounded-sm border-red-400/25 bg-red-400/5 p-5"
            >
              <AlertTitle className="font-serif text-[length:var(--text-body)] text-warm-dim mb-3">
                Something went wrong during{" "}
                {firstErrored ? firstErrored.label.toLowerCase() : "processing"}.
              </AlertTitle>
              <AlertDescription className="font-mono text-[length:var(--text-chrome)] text-red-400/90 mb-4">
                {overallError}
              </AlertDescription>
              <div className="flex items-center gap-4">
                {onRetry && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={onRetry}
                    className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                               text-gold hover:text-gold-hover hover:bg-transparent
                               rounded-sm h-auto px-3 py-1"
                  >
                    retry
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => navigate("/")}
                  className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                             text-warm-ghost hover:text-warm-faint hover:bg-transparent
                             rounded-sm h-auto px-3 py-1"
                >
                  back to home
                </Button>
              </div>
            </Alert>
          )}

          {overallCancelled && (
            <div className="mb-10 rounded-sm border border-ink-border bg-ink-raised p-5">
              <p className="font-serif text-[length:var(--text-body)] text-warm-dim mb-4">
                Update cancelled
              </p>
              <div className="flex items-center gap-4">
                {onRetry && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={onRetry}
                    className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                               text-gold hover:text-gold-hover hover:bg-transparent
                               rounded-sm h-auto px-3 py-1"
                  >
                    run again
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => navigate("/")}
                  className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                             text-warm-ghost hover:text-warm-faint hover:bg-transparent
                             rounded-sm h-auto px-3 py-1"
                >
                  back to home
                </Button>
              </div>
            </div>
          )}

          {!noJobFound && stages.length > 0 && (
            <>
              {stages.map((stage) => {
                const origIndex = stages.indexOf(stage);
                return (
                  <PipelineStageRow
                    key={stage.stage}
                    stage={stage}
                    index={origIndex}
                    ref={stage.active ? activeRef : undefined}
                    shouldAnimate={shouldAnimate}
                    showCompletionFlourish={showCompletion && stage.complete}
                  />
                );
              })}
            </>
          )}

          {/* Completion summary */}
          {!noJobFound && overallDone && !overallError && (
            <motion.div
              className="mt-10 p-6 rounded-sm border border-gold-dim bg-ink-raised"
              initial={shouldAnimate ? { opacity: 0, y: 8 } : {}}
              animate={{ opacity: 1, y: 0 }}
              transition={
                shouldAnimate ? { duration: 0.3, ease: EASE_OUT, delay: 0.2 } : { duration: 0 }
              }
            >
              <p className="font-serif text-[length:var(--text-body)] text-warm-dim mb-1">
                Knowledge base updated
              </p>
              {result && (
                <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost mb-5">
                  {result.pagination.total === 0
                    ? "Already up to date — nothing changed"
                    : `${result.pagination.total} ${result.pagination.total === 1 ? "article" : "articles"} written`}
                </p>
              )}
              {result && result.items.length > 0 && (
                <ul className="mb-6 space-y-1.5">
                  {result.items.map((a) => (
                    <li key={a.slug}>
                      <button
                        onClick={() => navigate(`/doc/${a.file_path}`)}
                        className="text-left font-serif text-[length:var(--text-small)] text-gold-dim
                                   hover:text-gold transition-colors"
                      >
                        {a.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-4">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => navigate("/explore")}
                  className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                             text-gold hover:text-gold-hover hover:bg-transparent
                             rounded-sm h-auto px-3 py-1.5"
                >
                  explore the wiki
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => navigate("/")}
                  className="font-mono text-[length:var(--text-chrome)] tracking-[0.1em]
                             text-warm-ghost hover:text-warm-faint hover:bg-transparent
                             rounded-sm h-auto px-3 py-1.5"
                >
                  back to home
                </Button>
              </div>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}

function PipelineStepChecklist({ steps }: { steps: ProgressStep[] }) {
  return (
    <ul className="mt-3 space-y-1.5">
      {steps.map((step) => {
        const isRunning = step.status === "running";
        const isCompleted = step.status === "completed";
        const isFailed = step.status === "failed";
        const hasCount = step.total != null && step.total > 0 && step.done != null;
        return (
          <li
            key={step.key}
            className="flex items-center gap-2 font-mono text-[length:var(--text-chrome)] tracking-[0.06em]"
          >
            <span
              className={
                isFailed
                  ? "text-warm-faint"
                  : isCompleted
                    ? "text-gold-dim"
                    : isRunning
                      ? "text-gold animate-[pulse-fade_1.6s_ease-in-out_infinite]"
                      : "text-warm-ghost"
              }
            >
              {isFailed ? "✗" : isCompleted ? "✓" : isRunning ? "◉" : "○"}
            </span>
            <span
              className={
                isCompleted ? "text-warm-ghost" : isRunning ? "text-warm-faint" : "text-warm-ghost"
              }
            >
              {step.label}
            </span>
            {hasCount && (
              <span className="tabular-nums text-warm-ghost">
                {step.done} / {step.total}
              </span>
            )}
            {step.detail && <span className="truncate text-warm-ghost">· {step.detail}</span>}
          </li>
        );
      })}
    </ul>
  );
}

interface PipelineStageRowProps {
  stage: StageProgress;
  index: number;
  shouldAnimate: boolean;
  showCompletionFlourish?: boolean;
  ref?: React.Ref<HTMLDivElement>;
}

/** Per-row open state derived from stage status, with a manual override
 *  scoped to the current status. Keying the override by status means a
 *  status transition (running → completed → failed) auto-invalidates a
 *  stale manual choice — e.g. collapsing an active phase that then errors
 *  re-expands on its own to surface the failure. */
function useStageOpen(stage: StageProgress): {
  expandable: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const status = stage.errored
    ? "failed"
    : stage.complete
      ? "completed"
      : stage.active
        ? "running"
        : "pending";
  const expandable = stage.active || stage.complete || stage.errored;
  const [override, setOverride] = useState<{ status: string; open: boolean } | null>(null);
  const open = override?.status === status ? override.open : expandable;
  return {
    expandable,
    open: expandable && open,
    setOpen: (next: boolean) => setOverride({ status, open: next }),
  };
}

function PipelineStageRow({
  stage,
  index,
  shouldAnimate,
  showCompletionFlourish,
  ref,
}: PipelineStageRowProps) {
  const isActive = stage.active;
  const isComplete = stage.complete;
  const isErrored = stage.errored;
  const hasCount = isActive && stage.total > 1;
  const { expandable, open, setOpen } = useStageOpen(stage);

  return (
    <motion.div
      ref={ref}
      className="border-b border-ink-subtle last:border-b-0"
      initial={shouldAnimate ? { opacity: 0, x: -8 } : {}}
      animate={{ opacity: 1, x: 0 }}
      transition={
        shouldAnimate
          ? {
              duration: 0.25,
              ease: EASE_OUT,
              delay: isComplete ? 0 : Math.min(index * 0.05, 0.3),
            }
          : { duration: 0 }
      }
    >
      <Collapsible open={open} onOpenChange={setOpen} disabled={!expandable}>
        <CollapsibleTrigger className="w-full flex items-center gap-4 py-4 text-left disabled:cursor-default">
          {/* Status icon */}
          <motion.span
            className="shrink-0 w-5 h-5 flex items-center justify-center"
            animate={showCompletionFlourish && shouldAnimate ? { scale: [1, 1.4, 1] } : {}}
            transition={
              showCompletionFlourish && shouldAnimate
                ? { duration: 0.4, ease: EASE_OUT, delay: index * 0.08 }
                : { duration: 0 }
            }
          >
            {isErrored ? (
              <span className="text-warm-faint text-sm">✗</span>
            ) : isComplete ? (
              <span className="text-gold-dim text-sm">✓</span>
            ) : isActive ? (
              <span className="text-gold animate-[pulse-fade_1.6s_ease-in-out_infinite] text-sm">
                ◉
              </span>
            ) : (
              <span className="text-warm-ghost text-sm">○</span>
            )}
          </motion.span>

          <span
            className={`flex-1 min-w-0 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] uppercase
                       ${isComplete ? "text-gold-dim" : isActive ? "text-gold" : isErrored ? "text-warm-faint" : "text-warm-ghost"}`}
          >
            {stage.label}
          </span>

          {hasCount && (
            <span className="shrink-0 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost">
              {stage.done} / {stage.total}
            </span>
          )}

          {expandable && (
            <ChevronDown
              size={14}
              className={`shrink-0 text-warm-ghost transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            />
          )}
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="pl-9 pb-4">
            {isActive && stage.detail && (
              <div className="font-serif text-[length:var(--text-small)] text-warm-faint">
                {stage.detail}
              </div>
            )}

            {stage.steps.length > 0 && <PipelineStepChecklist steps={stage.steps} />}

            {isActive && stage.total > 1 && (
              <Progress
                value={(stage.done / stage.total) * 100}
                className="mt-2 [&_[data-slot=progress-track]]:bg-ink-border [&_[data-slot=progress-indicator]]:bg-gold"
              />
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </motion.div>
  );
}
