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
  { stage: "uploading", label: "Uploading", activeLabel: "Uploading N files…" },
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
 * Upload is tracked separately via the bulk ingest task.
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

export function usePipelineProgress() {
  const [stages, setStages] = useState<StageProgress[]>([]);
  const [overallDone, setOverallDone] = useState(false);
  const [overallError, setOverallError] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeCompileIntentId, setActiveCompileIntentId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const compilePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPolls = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (compilePollRef.current) {
      clearInterval(compilePollRef.current);
      compilePollRef.current = null;
    }
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
          total: isActive ? stageTotal : isComplete ? 1 : 1,
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

      // Upload stage active
      setStages(buildStages("uploading", 0, fileCount, null, `Uploading ${fileCount} files…`));

      pollRef.current = setInterval(async () => {
        try {
          const task: TaskDetail = await getTask(taskId);
          setStages(
            buildStages(
              "uploading",
              task.progress_done,
              Math.max(task.progress_total, fileCount),
              null,
              `Uploading ${task.progress_done} of ${Math.max(task.progress_total, fileCount)} files…`,
            ),
          );

          if (task.status === "completed") {
            // Upload done — mark uploading complete and trigger compile
            setStages(buildStages("indexing", 0, 1, null, "Indexing documents for search…"));
            clearInterval(pollRef.current!);
            pollRef.current = null;

            // Trigger compile
            const intent: CompileIntent = await compile();
            setActiveCompileIntentId(intent.id);
            watchCompile(intent.id);
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

  /** Watch a compile task's progress. */
  const watchCompile = useCallback(
    (intentId: string) => {
      compilePollRef.current = setInterval(async () => {
        try {
          const intent: CompileIntent = await getCompileIntent(intentId);
          if (intent.status === "satisfied") {
            // All done
            setStages((prev) => prev.map((s) => ({ ...s, active: false, complete: true })));
            setOverallDone(true);
            clearInterval(compilePollRef.current!);
            compilePollRef.current = null;
            return;
          }

          if (intent.status === "dispatched" && intent.dispatched_task_id) {
            // Poll the underlying task for progress
            const task: TaskDetail = await getTask(intent.dispatched_task_id);
            if (task.progress_total > 0) {
              const stageIdx = estimateCompileStage(task.progress_done, task.progress_total);
              // Stages after "uploading" (compile phases 0-6)
              const compileStages: PipelineStage[] = [
                "indexing",
                "reading",
                "synthesizing",
                "connecting",
                "writing",
                "checking",
                "publishing",
              ];
              const currentStage = compileStages[Math.min(stageIdx, compileStages.length - 1)];
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
            }
          }
        } catch {
          // retry next interval
        }
      }, COMPILE_POLL_MS);
    },
    [buildStages],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => clearPolls();
  }, [clearPolls]);

  const reset = useCallback(() => {
    clearPolls();
    setStages([]);
    setOverallDone(false);
    setOverallError(null);
    setActiveTaskId(null);
    setActiveCompileIntentId(null);
  }, [clearPolls]);

  return {
    stages,
    overallDone,
    overallError,
    activeTaskId,
    activeCompileIntentId,
    watchBulkTask,
    reset,
  };
}
