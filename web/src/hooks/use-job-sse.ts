import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { apiFetch, vaultPath } from "@/api/client";
import { useActiveVaultId } from "@/hooks/use-vault";

export type PipelineStage =
  | "uploading"
  | "indexing"
  | "reading"
  | "synthesizing"
  | "connecting"
  | "writing"
  | "checking"
  | "publishing";

type BackendPhase =
  | "source_ingest"
  | "ingest"
  | "extract"
  | "abstract"
  | "derive"
  | "render"
  | "verify"
  | "publish";

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

interface BackendPipelineEvent {
  id: string;
  phase: string;
  phase_status: "started" | "progress" | "completed" | "failed";
  job_status?: "pending" | "running" | "completed" | "failed" | "cancelled";
  progress?: {
    done: number;
    total: number;
    failed_items?: number;
  };
  error?: string;
  message?: string;
}

interface PipelineEvent extends BackendPipelineEvent {
  backendPhase: BackendPhase;
  phase: PipelineStage;
}

interface SseMessage {
  event: string;
  data: string;
}

const PHASE_TO_STAGE: Record<BackendPhase, PipelineStage> = {
  source_ingest: "uploading",
  ingest: "indexing",
  extract: "reading",
  abstract: "synthesizing",
  derive: "connecting",
  render: "writing",
  verify: "checking",
  publish: "publishing",
};

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

function normalizeEvent(raw: BackendPipelineEvent): PipelineEvent | null {
  const backendPhase = raw.phase as BackendPhase;
  const stage = PHASE_TO_STAGE[backendPhase];
  if (!stage) return null;
  return { ...raw, backendPhase, phase: stage };
}

function parseSseBlock(block: string): SseMessage | null {
  let event = "message";
  const data: string[] = [];

  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;

    const sep = line.indexOf(":");
    const field = sep === -1 ? line : line.slice(0, sep);
    let value = sep === -1 ? "" : line.slice(sep + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }

  if (event === "message" && data.length === 0) return null;
  return { event, data: data.join("\n") };
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
      const progress = event.progress;
      const total = progress && progress.total > 0 ? progress.total : s.total;
      const done =
        event.phase_status === "completed" && !progress ? total : (progress?.done ?? s.done);
      const isComplete =
        event.phase_status === "completed" ||
        (event.phase_status === "progress" && done >= total && total > 0);
      const isFailed = event.phase_status === "failed";
      return {
        ...s,
        active: !isComplete && !isFailed,
        complete: isComplete,
        errored: isFailed,
        done,
        total,
        detail: event.error
          ? event.error
          : event.message
            ? event.message
            : isComplete
              ? ""
              : event.phase === "reading"
                ? `Reading document ${done} of ${total}…`
                : event.phase === "writing"
                  ? `Writing article ${done} of ${total}…`
                  : total > 1
                    ? `${done} of ${total}`
                    : STAGES[phaseIdx].activeLabel,
      };
    }
    // Future phases — keep as pending
    return { ...s, active: false, complete: false, errored: false };
  });
}

/**
 * Subscribes to the SSE progress stream for a job.
 * Uses fetch streaming rather than EventSource so auth works through the
 * same Authorization-header path as every other API request.
 */
export function useJobSSE(jobId: string | null) {
  const vaultId = useActiveVaultId();
  const queryClient = useQueryClient();
  const [stages, setStages] = useState<StageProgress[]>(emptyStages);
  const [overallDone, setOverallDone] = useState(false);
  const [overallError, setOverallError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const disconnect = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort();
      controllerRef.current = null;
    }
    setConnected(false);
  }, []);

  const invalidateActivePipeline = useCallback(() => {
    if (!vaultId) return;
    queryClient.invalidateQueries({ queryKey: ["vault", vaultId, "active-job"] });
  }, [queryClient, vaultId]);

  useEffect(() => {
    if (!jobId || !vaultId) return;

    disconnect();
    setOverallDone(false);
    setOverallError(null);
    setStages(emptyStages());

    const controller = new AbortController();
    controllerRef.current = controller;
    let cancelled = false;

    const handleMessage = (msg: SseMessage) => {
      if (msg.event === "connected") {
        setConnected(true);
        return;
      }

      if (msg.event === "done") {
        setOverallDone(true);
        invalidateActivePipeline();
        disconnect();
        return;
      }

      if (!msg.data) return;

      try {
        const raw: BackendPipelineEvent = JSON.parse(msg.data);
        const data = normalizeEvent(raw);
        if (!data) return;

        if (
          data.phase_status === "failed" ||
          data.job_status === "failed" ||
          data.job_status === "cancelled"
        ) {
          setOverallError(data.error ?? "Pipeline failed");
          setStages((prev) => applyEvent(prev, data));
          invalidateActivePipeline();
          return;
        }

        if (data.backendPhase === "publish" && data.phase_status === "completed") {
          setStages((prev) => {
            const withLast = applyEvent(prev, data);
            return withLast.map((s) => ({ ...s, active: false, complete: true }));
          });
          setOverallDone(true);
          invalidateActivePipeline();
          return;
        }

        if (data.job_status === "completed") {
          setOverallDone(true);
          invalidateActivePipeline();
        }

        setStages((prev) => applyEvent(prev, data));
      } catch {
        // Ignore malformed events
      }
    };

    const run = async () => {
      try {
        const res = await apiFetch(vaultPath(`/jobs/${jobId}/stream`), {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });

        if (!res.ok) {
          setOverallError(await res.text());
          return;
        }
        if (!res.body) {
          setOverallError("Progress stream unavailable");
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

          let sep = buffer.indexOf("\n\n");
          while (sep !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const msg = parseSseBlock(block);
            if (msg) handleMessage(msg);
            sep = buffer.indexOf("\n\n");
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setOverallError(e instanceof Error ? e.message : "Progress stream failed");
        }
      } finally {
        setConnected(false);
      }
    };

    run();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [jobId, vaultId, disconnect, invalidateActivePipeline]);

  return {
    stages,
    overallDone,
    overallError,
    connected,
    disconnect,
  };
}
