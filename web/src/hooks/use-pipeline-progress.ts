import { useCallback, useEffect, useRef, useState } from "react";

import { getTask, listTasks, type TaskDetail } from "@/api/ingest";

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
const COMPILE_FIND_RETRIES = 15; // ~30 seconds of polling before giving up

/**
 * Approximate weight of each compile phase relative to total work.
 */
const PHASE_WEIGHTS: number[] = [5, 40, 15, 5, 30, 3, 2];

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

/**
 * The bulk worker automatically creates a compile intent when it finishes.
 * We find the resulting compile task by polling the tasks list.
 */
async function findActiveCompileTask(): Promise<TaskDetail | null> {
  const tasks = await listTasks(20);
  return (
    tasks.find((t) => t.type === "compile" && (t.status === "pending" || t.status === "running")) ??
    null
  );
}

async function findCompletedCompileTask(): Promise<TaskDetail | null> {
  const tasks = await listTasks(20);
  return tasks.find((t) => t.type === "compile" && t.status === "completed") ?? null;
}

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

  /** Poll a compile task directly for its progress. */
  const watchCompileTask = useCallback(
    (taskId: string) => {
      compilePollRef.current = setInterval(async () => {
        try {
          const task: TaskDetail = await getTask(taskId);

          if (task.status === "completed") {
            setStages((prev) => prev.map((s) => ({ ...s, active: false, complete: true })));
            setOverallDone(true);
            clearInterval(compilePollRef.current!);
            compilePollRef.current = null;
            return;
          }

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
            setStages(buildStages("indexing", 0, 1, null, "Starting compile…"));
          }
        } catch {
          // retry next interval
        }
      }, COMPILE_POLL_MS);
    },
    [buildStages],
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
            if (compileTriggeredRef.current) return;
            compileTriggeredRef.current = true;

            // Bulk task done. The backend worker auto-creates a compile
            // intent. Poll for the resulting compile task.
            setStages(buildStages("indexing", 0, 1, null, "Preparing to compile…"));
            clearInterval(pollRef.current!);
            pollRef.current = null;

            // Check if compile task was already created (backend auto-creates intent)
            let compileTask = await findActiveCompileTask();
            if (compileTask) {
              watchCompileTask(compileTask.id);
              return;
            }

            // If not immediately visible, check for a just-completed one
            compileTask = await findCompletedCompileTask();
            if (compileTask) {
              setStages((prev) => prev.map((s) => ({ ...s, active: false, complete: true })));
              setOverallDone(true);
              return;
            }

            // Poll until the compile task appears or we timeout
            let retries = 0;
            const findInterval = setInterval(async () => {
              retries++;
              const ct = (await findActiveCompileTask()) ?? (await findCompletedCompileTask());
              if (ct) {
                clearInterval(findInterval);
                if (ct.status === "completed") {
                  setStages((prev) => prev.map((s) => ({ ...s, active: false, complete: true })));
                  setOverallDone(true);
                } else {
                  watchCompileTask(ct.id);
                }
              } else if (retries >= COMPILE_FIND_RETRIES) {
                clearInterval(findInterval);
                setOverallError(
                  "Compile task not found — it may have been queued. Check back shortly.",
                );
              }
            }, COMPILE_POLL_MS);
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
    [clearPolls, buildStages, watchCompileTask],
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
