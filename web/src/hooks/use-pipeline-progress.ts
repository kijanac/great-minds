import { useCallback, useEffect, useRef, useState } from "react";

import { compile, getCompileIntent, type CompileIntent } from "@/api/compile";
import { getTask, type TaskDetail } from "@/api/ingest";

export type PipelineStage =
  | "uploading"
  | "indexing"
  | "reading"
  | "synthesizing"
  | "connecting"
  | "writing"
  | "checking"
  | "publishing";

export interface StageProgress {
  stage: PipelineStage;
  label: string;
  detail: string;
  done: number;
  total: number;
  active: boolean;
  complete: boolean;
  errored: boolean;
}

const STAGES: { stage: PipelineStage; label: string; activeLabel: string }[] = [
  { stage: "uploading", label: "Uploading", activeLabel: "Uploading files…" },
  { stage: "indexing", label: "Indexing", activeLabel: "Indexing documents for search…" },
  { stage: "reading", label: "Reading", activeLabel: "Reading documents…" },
  { stage: "synthesizing", label: "Synthesizing", activeLabel: "Synthesizing topics…" },
  { stage: "connecting", label: "Connecting", activeLabel: "Mapping connections…" },
  { stage: "writing", label: "Writing", activeLabel: "Writing articles…" },
  { stage: "checking", label: "Checking", activeLabel: "Checking references…" },
  { stage: "publishing", label: "Publishing", activeLabel: "Finalizing…" },
];

const TASK_POLL_MS = 1500;
const COMPILE_POLL_MS = 2000;

/**
 * Approximate weight of each compile phase relative to total work.
 * Used to estimate which phase the compile is in from overall progress.
 */
const PHASE_WEIGHTS: number[] = [5, 40, 15, 5, 30, 3, 2]; // index, read, synth, connect, write, check, pub

function estimateCompileStage(progressDone: number, progressTotal: number): number {
  if (progressTotal <= 0) return 0;
  const pct = progressDone / progressTotal;
  let cumulative = 0;
  for (let i = 0; i < PHASE_WEIGHTS.length; i++) {
    cumulative += PHASE_WEIGHTS[i] / 100;
    if (pct <= cumulative) return i;
  }
  return PHASE_WEIGHTS.length - 1;
}

const COMPILE_STAGES: PipelineStage[] = [
  "indexing",
  "reading",
  "synthesizing",
  "connecting",
  "writing",
  "checking",
  "publishing",
];

export function usePipelineProgress() {
  const [stages, setStages] = useState<StageProgress[]>([]);
  const [overallDone, setOverallDone] = useState(false);
  const [overallError, setOverallError] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const compilePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const compileTriggeredRef = useRef(false);

  const clearPolls = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (compilePollRef.current) {
      clearInterval(compilePollRef.current);
      compilePollRef.current = null;
    }
    compileTriggeredRef.current = false;
  }, []);

  const buildStages = useCallback(
    (
      currentStage: PipelineStage,
      stageDone: number,
      stageTotal: number,
      erroredStage: PipelineStage | null,
      detail?: string,
    ): StageProgress[] => {
      let foundActive = false;
      return STAGES.map((s) => {
        const isActive = s.stage === currentStage;
        const isComplete = !foundActive && !isActive;
        if (isActive) foundActive = true;
        return {
          stage: s.stage,
          label: s.label,
          detail: isActive ? (detail ?? s.activeLabel) : "",
          done: isActive ? stageDone : isComplete ? 1 : 0,
          total: isActive && stageTotal > 0 ? stageTotal : isComplete ? 1 : 1,
          active: isActive,
          complete: isComplete,
          errored: s.stage === erroredStage,
        };
      });
    },
    [],
  );

  /** Start watching a bulk ingest task. */
  const watchBulkTask = useCallback(
    (taskId: string, fileCount: number) => {
      clearPolls();
      setActiveTaskId(taskId);
      setOverallDone(false);
      setOverallError(null);

      setStages(buildStages("uploading", 0, fileCount, null, `Uploading ${fileCount} files…`));

      pollRef.current = setInterval(async () => {
        try {
          const task: TaskDetail = await getTask(taskId);
          const total = task.progress_total > 0 ? task.progress_total : fileCount;
          const done = task.progress_done;

          setStages(
            buildStages("uploading", done, total, null, `Uploading ${done} of ${total} files…`),
          );

          if (task.status === "completed") {
            // Guard against double-trigger from React re-renders
            if (compileTriggeredRef.current) return;
            compileTriggeredRef.current = true;

            // Bulk task done — show compile-prep stage while the intent dispatches
            setStages(buildStages("indexing", 0, 1, null, "Preparing to compile…"));
            clearInterval(pollRef.current!);
            pollRef.current = null;

            try {
              const intent: CompileIntent = await compile();
              watchCompile(intent.id);
            } catch (e) {
              setOverallError(e instanceof Error ? e.message : "Failed to start compile");
              setStages((prev) =>
                prev.map((s) =>
                  s.stage === "indexing"
                    ? { ...s, errored: true, detail: "Failed to start compile" }
                    : s,
                ),
              );
            }
          } else if (task.status === "failed" || task.status === "cancelled") {
            const err = task.error ?? `Task ${task.status}`;
            setOverallError(err);
            setStages((prev) =>
              prev.map((s) => (s.stage === "uploading" ? { ...s, errored: true, detail: err } : s)),
            );
            clearInterval(pollRef.current!);
            pollRef.current = null;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Poll failed";
          setOverallError(msg);
          clearInterval(pollRef.current!);
          pollRef.current = null;
        }
      }, TASK_POLL_MS);
    },
    [clearPolls, buildStages],
  );

  /** Watch a compile intent → task → progress. */
  const watchCompile = useCallback(
    (intentId: string) => {
      compilePollRef.current = setInterval(async () => {
        try {
          const intent: CompileIntent = await getCompileIntent(intentId);

          if (intent.status === "satisfied") {
            setStages((prev) => prev.map((s) => ({ ...s, active: false, complete: true })));
            setOverallDone(true);
            clearInterval(compilePollRef.current!);
            compilePollRef.current = null;
            return;
          }

          if (intent.status === "pending") {
            // Still waiting for the reconciler to dispatch — keep showing "Preparing"
            setStages(buildStages("indexing", 0, 1, null, "Preparing to compile…"));
            return;
          }

          if (intent.status === "dispatched" && intent.dispatched_task_id) {
            const task: TaskDetail = await getTask(intent.dispatched_task_id);

            if (task.status === "failed" || task.status === "cancelled") {
              const err = task.error ?? `Compile ${task.status}`;
              setOverallError(err);
              setStages((prev) => {
                const activeIdx = prev.findIndex((s) => s.active);
                if (activeIdx === -1) return prev;
                return prev.map((s, i) =>
                  i === activeIdx ? { ...s, errored: true, detail: err } : s,
                );
              });
              clearInterval(compilePollRef.current!);
              compilePollRef.current = null;
              return;
            }

            if (task.progress_total > 0) {
              const stageIdx = estimateCompileStage(task.progress_done, task.progress_total);
              const currentStage = COMPILE_STAGES[Math.min(stageIdx, COMPILE_STAGES.length - 1)];
              const stageDef = STAGES.find((s) => s.stage === currentStage)!;
              setStages(
                buildStages(
                  currentStage,
                  task.progress_done,
                  task.progress_total,
                  null,
                  stageDef.activeLabel,
                ),
              );
            } else {
              // Task dispatched but no progress yet — keep showing indexing
              setStages(buildStages("indexing", 0, 1, null, "Starting compile…"));
            }
          }
        } catch {
          // retry next interval
        }
      }, COMPILE_POLL_MS);
    },
    [buildStages],
  );

  useEffect(() => {
    return () => clearPolls();
  }, [clearPolls]);

  const reset = useCallback(() => {
    clearPolls();
    setStages([]);
    setOverallDone(false);
    setOverallError(null);
    setActiveTaskId(null);
  }, [clearPolls]);

  return {
    stages,
    overallDone,
    overallError,
    activeTaskId,
    watchBulkTask,
    reset,
  };
}
