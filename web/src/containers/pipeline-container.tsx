import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { getTask, ingestUrl, listTasks } from "@/api/ingest";
import { PipelinePage } from "@/components/pipeline-page";
import { usePipelineSSE } from "@/hooks/use-pipeline-sse";
import type { StageProgress } from "@/hooks/use-pipeline-sse";

const BULK_POLL_MS = 1500;

function uploadingStages(fileCount: number): StageProgress[] {
  const out: StageProgress[] = [];
  const stages = [
    { stage: "uploading" as const, label: "Uploading" },
    { stage: "indexing" as const, label: "Indexing" },
    { stage: "reading" as const, label: "Reading" },
    { stage: "synthesizing" as const, label: "Synthesizing" },
    { stage: "connecting" as const, label: "Connecting" },
    { stage: "writing" as const, label: "Writing" },
    { stage: "checking" as const, label: "Checking" },
    { stage: "publishing" as const, label: "Publishing" },
  ];
  for (const s of stages) {
    out.push({
      stage: s.stage,
      label: s.label,
      detail: "",
      done: s.stage === "uploading" ? 0 : 0,
      total: s.stage === "uploading" ? fileCount : 1,
      active: s.stage === "uploading",
      complete: false,
      errored: false,
    });
  }
  return out;
}

export function PipelineContainer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [{ taskId: bulkTaskId, fileCount, urlParam }] = useState(() => {
    const tid = searchParams.get("task_id");
    const fc = parseInt(searchParams.get("file_count") ?? "0", 10);
    const u = searchParams.get("url");
    if (tid || u) setSearchParams({}, { replace: true });
    return { taskId: tid, fileCount: fc, urlParam: u };
  });

  // Compile task SSE
  const [compileTaskId, setCompileTaskId] = useState<string | null>(null);
  const { stages: compileStages, overallDone, connected } = usePipelineSSE(compileTaskId);

  // Bulk task progress (short-lived, REST-polled)
  const [bulkStages, setBulkStages] = useState<StageProgress[]>(
    fileCount > 0 ? uploadingStages(fileCount) : [],
  );
  const [bulkDone, setBulkDone] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [noTaskFound, setNoTaskFound] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedRef = useRef(false);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Find and start SSE for a compile task
  const findAndWatchCompile = useCallback(async () => {
    const tasks = await listTasks(20);
    const ct = tasks.find(
      (t) =>
        t.type === "compile" &&
        (t.status === "pending" || t.status === "running" || t.status === "completed"),
    );
    if (ct) {
      if (ct.status === "completed") {
        setBulkDone(true);
        setBulkStages((prev) => prev.map((s) => ({ ...s, active: false, complete: true })));
        return;
      }
      setCompileTaskId(ct.id);
    }
    return ct;
  }, []);

  // Path 1: Bulk task → poll until complete → find compile → SSE
  useEffect(() => {
    if (!bulkTaskId || fileCount <= 0 || startedRef.current) return;
    startedRef.current = true;

    setBulkStages(uploadingStages(fileCount));

    pollRef.current = setInterval(async () => {
      try {
        const task = await getTask(bulkTaskId);
        setBulkStages((prev) =>
          prev.map((s) =>
            s.stage === "uploading"
              ? {
                  ...s,
                  done: task.progress_done,
                  total: task.progress_total > 0 ? task.progress_total : fileCount,
                  detail: `Processing ${task.progress_done} of ${task.progress_total > 0 ? task.progress_total : fileCount} files…`,
                }
              : s,
          ),
        );

        if (task.status === "completed") {
          clearPoll();
          setBulkDone(true);
          // Find the auto-created compile task
          await findAndWatchCompile();
        } else if (task.status === "failed" || task.status === "cancelled") {
          clearPoll();
          setBulkError(task.error ?? `Task ${task.status}`);
          setBulkStages((prev) =>
            prev.map((s) =>
              s.stage === "uploading"
                ? { ...s, errored: true, detail: task.error ?? "Task failed", active: false }
                : s,
            ),
          );
        }
      } catch (e) {
        clearPoll();
        setBulkError(e instanceof Error ? e.message : "Poll failed");
      }
    }, BULK_POLL_MS);

    return () => clearPoll();
  }, [bulkTaskId, fileCount, clearPoll, findAndWatchCompile]);

  // Path 2: URL ingest
  const urlIngestedRef = useRef(false);
  useEffect(() => {
    if (!urlParam || urlIngestedRef.current || startedRef.current) return;
    urlIngestedRef.current = true;
    startedRef.current = true;

    (async () => {
      try {
        await ingestUrl(urlParam);
      } catch {
        // Continue — maybe there's already a compile running
      }
      const ct = await findAndWatchCompile();
      if (!ct) {
        setBulkStages([]);
        setNoTaskFound(true);
      }
    })();
  }, [urlParam, findAndWatchCompile]);

  // Path 3: Resume (no params)
  const resumeRef = useRef(false);
  useEffect(() => {
    if (bulkTaskId || urlParam || resumeRef.current || startedRef.current) return;
    resumeRef.current = true;
    startedRef.current = true;

    (async () => {
      const ct = await findAndWatchCompile();
      if (ct) return;

      // Check for completed bulk task
      const tasks = await listTasks(10);
      const completedBulk = tasks.find(
        (t) => t.type === "bulk_ingest_from_staging" && t.status === "completed",
      );
      if (completedBulk) {
        // Bulk is done, compile task might just not be visible yet
        setBulkStages((prev) => prev.map((s) => ({ ...s, active: false, complete: true })));
        setBulkDone(true);
        // Try again after a short delay
        const retry = setTimeout(async () => {
          await findAndWatchCompile();
        }, 3000);
        return () => clearTimeout(retry);
      }

      setBulkStages([]);
      setNoTaskFound(true);
    })();
  }, [bulkTaskId, urlParam, findAndWatchCompile]);

  // Merge bulk + compile stages
  const stages = compileTaskId ? compileStages : bulkStages;
  const done = compileTaskId ? overallDone : bulkDone;
  const error = compileTaskId ? null : bulkError;

  return (
    <PipelinePage
      stages={stages}
      overallDone={done}
      overallError={error}
      noTaskFound={noTaskFound}
      connected={compileTaskId ? connected : undefined}
    />
  );
}
