import { useCallback, useEffect, useRef, useState } from "react";

import { useActiveVaultId } from "@/hooks/use-vault";

function getAccessToken(): string | null {
  return localStorage.getItem("access_token");
}

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

interface PipelineEvent {
  task_id: string;
  phase: string;
  status: "started" | "progress" | "completed" | "failed";
  done: number;
  total: number;
  error?: string;
  early_exit?: boolean;
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

function emptyStages(): StageProgress[] {
  return STAGES.map((s) => ({
    stage: s.stage,
    label: s.label,
    detail: "",
    done: 0,
    total: 1,
    active: false,
    complete: false,
    errored: false,
  }));
}

function applyEvent(prev: StageProgress[], event: PipelineEvent): StageProgress[] {
  const phaseIdx = STAGES.findIndex((s) => s.stage === event.phase);
  if (phaseIdx === -1) return prev;

  return prev.map((s, i) => {
    if (i < phaseIdx) {
      // Prior phases are complete
      return { ...s, active: false, complete: true, errored: false };
    }
    if (i === phaseIdx) {
      const isComplete =
        event.status === "completed" ||
        (event.status === "progress" && event.done >= event.total && event.total > 0);
      const isFailed = event.status === "failed";
      return {
        ...s,
        active: !isComplete && !isFailed,
        complete: isComplete,
        errored: isFailed,
        done: event.done,
        total: event.total > 0 ? event.total : s.total,
        detail: event.error
          ? event.error
          : isComplete
            ? ""
            : event.phase === "reading"
              ? `Reading document ${event.done} of ${event.total}…`
              : event.phase === "writing"
                ? `Writing article ${event.done} of ${event.total}…`
                : event.total > 1
                  ? `${event.done} of ${event.total}`
                  : STAGES[phaseIdx].activeLabel,
      };
    }
    // Future phases — keep as pending
    return { ...s, active: false, complete: false, errored: false };
  });
}

/**
 * Subscribes to the SSE progress stream for a compile task.
 * Returns stage-by-stage progress with zero client-side polling.
 */
export function usePipelineSSE(taskId: string | null) {
  const vaultId = useActiveVaultId();
  const [stages, setStages] = useState<StageProgress[]>(emptyStages);
  const [overallDone, setOverallDone] = useState(false);
  const [overallError, setOverallError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const disconnect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setConnected(false);
  }, []);

  useEffect(() => {
    if (!taskId || !vaultId) return;

    const token = getAccessToken();
    if (!token) return;

    disconnect();
    setOverallDone(false);
    setOverallError(null);
    setStages(emptyStages());

    const url = `/v1/vaults/${vaultId}/tasks/${taskId}/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("connected", () => {
      setConnected(true);
    });

    es.onmessage = (event) => {
      try {
        const data: PipelineEvent = JSON.parse(event.data);

        if (data.phase === "publish" && data.status === "completed") {
          setStages((prev) => {
            const withLast = applyEvent(prev, data);
            return withLast.map((s) => ({ ...s, active: false, complete: true }));
          });
          setOverallDone(true);
          return;
        }

        if (data.status === "completed" && data.phase === "abstract" && data.early_exit) {
          // No topics to compile — mark everything complete
          setStages((prev) => prev.map((s) => ({ ...s, active: false, complete: true })));
          setOverallDone(true);
          return;
        }

        setStages((prev) => applyEvent(prev, data));
      } catch {
        // Ignore malformed events
      }
    };

    es.onerror = () => {
      setConnected(false);
      // EventSource will auto-reconnect
    };

    es.addEventListener("done", () => {
      setOverallDone(true);
      disconnect();
    });

    return () => {
      disconnect();
    };
  }, [taskId, vaultId, disconnect]);

  return {
    stages,
    overallDone,
    overallError,
    connected,
    disconnect,
  };
}
