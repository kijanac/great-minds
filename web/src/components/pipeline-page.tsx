import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { StageProgress } from "@/hooks/use-pipeline-sse";
import { useViewNavigate } from "@/hooks/use-view-navigate";

interface PipelinePageProps {
  stages: StageProgress[];
  overallDone: boolean;
  overallError: string | null;
  noTaskFound?: boolean;
  connected?: boolean;
}

const EASE_OUT: [number, number, number, number] = [0.25, 1, 0.5, 1];

export function PipelinePage({
  stages,
  overallDone,
  overallError,
  noTaskFound,
  connected: _connected,
}: PipelinePageProps) {
  const navigate = useViewNavigate();
  const prefersReducedMotion = useReducedMotion();
  const shouldAnimate = !prefersReducedMotion;
  const activeRef = useRef<HTMLDivElement>(null);

  // Auto-scroll active stage into view
  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [stages]);

  const completedCount = stages.filter((s) => s.complete).length;
  const firstErrored = stages.find((s) => s.errored);

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
        <span className="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase">
          compile
        </span>
      </div>

      {/* Pipeline stages */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[640px] mx-auto px-4 md:px-10 pt-10 pb-20">
          {noTaskFound && !overallError && (
            <div className="text-center pt-8">
              <p className="font-serif text-[length:var(--text-body)] text-warm-dim mb-2">
                No active pipeline
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

          {!noTaskFound && stages.length === 0 && !overallError && (
            <p className="text-[length:var(--text-body)] text-warm-faint animate-[pulse-fade_1.6s_ease-in-out_infinite] font-mono">
              preparing…
            </p>
          )}

          {overallError && (
            <div className="mb-10 p-5 rounded-sm border border-ink-border bg-ink-raised">
              <p className="font-serif text-[length:var(--text-body)] text-warm-dim mb-3">
                Something went wrong during{" "}
                {firstErrored ? firstErrored.label.toLowerCase() : "processing"}.
              </p>
              <p className="font-mono text-[length:var(--text-chrome)] text-warm-faint mb-4">
                {overallError}
              </p>
              <div className="flex gap-3">
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
            </div>
          )}

          {!noTaskFound &&
            stages.map((stage, i) => (
              <PipelineStageRow
                key={stage.stage}
                stage={stage}
                index={i}
                ref={stage.active ? activeRef : undefined}
                shouldAnimate={shouldAnimate}
              />
            ))}

          {/* Completion summary */}
          {!noTaskFound && overallDone && !overallError && (
            <motion.div
              className="mt-10 p-6 rounded-sm border border-gold-dim bg-ink-raised"
              initial={shouldAnimate ? { opacity: 0, y: 8 } : {}}
              animate={{ opacity: 1, y: 0 }}
              transition={
                shouldAnimate ? { duration: 0.3, ease: EASE_OUT, delay: 0.2 } : { duration: 0 }
              }
            >
              <p className="font-serif text-[length:var(--text-body)] text-warm-dim mb-1">
                Compile complete
              </p>
              <p className="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost mb-5">
                {completedCount} of {stages.length} stages finished
              </p>
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

interface PipelineStageRowProps {
  stage: StageProgress;
  index: number;
  shouldAnimate: boolean;
  ref?: React.Ref<HTMLDivElement>;
}

function PipelineStageRow({ stage, index, shouldAnimate, ref }: PipelineStageRowProps) {
  const isActive = stage.active;
  const isComplete = stage.complete;
  const isErrored = stage.errored;

  return (
    <motion.div
      ref={ref}
      className="flex items-start gap-4 py-4 border-b border-ink-subtle last:border-b-0"
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
      {/* Status icon */}
      <div className="shrink-0 w-5 h-5 flex items-center justify-center mt-0.5">
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
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div
          className={`font-mono text-[length:var(--text-chrome)] tracking-[0.1em] uppercase
                     ${isComplete ? "text-gold-dim" : isActive ? "text-gold" : isErrored ? "text-warm-faint" : "text-warm-ghost"}`}
        >
          {stage.label}
        </div>

        {isActive && stage.detail && (
          <div className="mt-1.5 font-serif text-[length:var(--text-small)] text-warm-faint">
            {stage.detail}
          </div>
        )}

        {/* Progress bar (active stages with total > 0) */}
        {isActive && stage.total > 1 && (
          <div className="mt-2 w-full h-1 rounded-full bg-ink-border overflow-hidden">
            <div
              className="h-full rounded-full bg-gold transition-all duration-500 ease-out"
              style={{
                width: `${(stage.done / stage.total) * 100}%`,
              }}
            />
          </div>
        )}
      </div>

      {/* Count (only for stages with real progress) */}
      {isActive && stage.total > 1 && (
        <div className="shrink-0 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost">
          {stage.done}
          {stage.total > 1 && <> / {stage.total}</>}
        </div>
      )}
    </motion.div>
  );
}
