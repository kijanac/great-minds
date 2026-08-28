import { useQueryClient } from "@tanstack/svelte-query";

import { apiFetch, vaultPathFor } from "$lib/api/client";
import { iterateSseMessages, type SseMessage } from "$lib/api/sse";
import { abortableSleep, retryDelay } from "$lib/api/stream-retry";
import { activeVault } from "$lib/hooks/use-vault.svelte";

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

export type ProgressStepStatus = "pending" | "running" | "completed" | "failed";

export interface ProgressStep {
  key: string;
  label: string;
  status: ProgressStepStatus;
  done: number | null;
  total: number | null;
  detail: string;
}

export interface StageProgress {
  stage: PipelineStage;
  label: string;
  detail: string;
  done: number;
  total: number;
  steps: ProgressStep[];
  active: boolean;
  complete: boolean;
  errored: boolean;
}

interface BackendPipelineEvent {
  id: string;
  trigger?: "staged_files" | "url" | "manual";
  phase: string;
  phase_status: "started" | "progress" | "completed" | "failed";
  job_status?: "pending" | "running" | "completed" | "failed" | "cancelled";
  steps: ProgressStep[];
  error?: string;
}

interface PipelineEvent extends BackendPipelineEvent {
  backendPhase: BackendPhase;
  phase: PipelineStage;
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

const STAGES: { stage: PipelineStage; label: string }[] = [
  { stage: "uploading", label: "Uploading" },
  { stage: "indexing", label: "Indexing" },
  { stage: "reading", label: "Reading" },
  { stage: "synthesizing", label: "Synthesizing" },
  { stage: "connecting", label: "Connecting" },
  { stage: "writing", label: "Writing" },
  { stage: "checking", label: "Checking" },
  { stage: "publishing", label: "Publishing" },
];

function emptyStages(): StageProgress[] {
  return STAGES.map((stage) => ({
    stage: stage.stage,
    label: stage.label,
    detail: "",
    done: 0,
    total: 1,
    steps: [],
    active: false,
    complete: false,
    errored: false,
  }));
}

function normalizeEvent(raw: BackendPipelineEvent): PipelineEvent | null {
  const backendPhase = raw.phase as BackendPhase;
  const phase = PHASE_TO_STAGE[backendPhase];
  return phase ? { ...raw, backendPhase, phase } : null;
}

function applyEvent(previous: StageProgress[], event: PipelineEvent): StageProgress[] {
  const phaseIndex = STAGES.findIndex((stage) => stage.stage === event.phase);
  if (phaseIndex === -1) return previous;

  return previous.map((stage, index) => {
    if (index < phaseIndex) {
      return { ...stage, active: false, complete: true, errored: false };
    }
    if (index === phaseIndex) {
      const complete = event.phase_status === "completed";
      const failed = event.phase_status === "failed";
      const activeStep = complete ? null : event.steps.find((step) => step.status === "running");
      const total = activeStep?.total && activeStep.total > 0 ? activeStep.total : 1;
      const done = activeStep?.done ?? 0;
      return {
        ...stage,
        active: !complete && !failed,
        complete,
        errored: failed,
        done,
        total,
        steps: event.steps,
        detail: event.error
          ? event.error
          : activeStep?.detail
            ? activeStep.detail
            : activeStep
              ? activeStep.total && activeStep.total > 0 && activeStep.done != null
                ? `${activeStep.label} ${activeStep.done} of ${activeStep.total}…`
                : `${activeStep.label}…`
              : "",
      };
    }
    return { ...stage, active: false, complete: false, errored: false };
  });
}

export function useJobSSE(
  jobId: () => string | null,
  jobVaultId: () => string | null = () => activeVault.id,
) {
  const queryClient = useQueryClient();
  let stages = $state<StageProgress[]>(emptyStages());
  let overallDone = $state(false);
  let overallError = $state<string | null>(null);
  let overallCancelled = $state(false);
  let trigger = $state<BackendPipelineEvent["trigger"]>(undefined);
  let backendPhase = $state("");
  let controller: AbortController | null = null;

  function disconnect() {
    controller?.abort();
    controller = null;
  }

  function invalidateActivePipeline(vaultId: string) {
    void queryClient.invalidateQueries({
      queryKey: ["vault", vaultId, "active-job"],
    });
  }

  $effect(() => {
    const id = jobId();
    const vaultId = jobVaultId();
    if (!id || !vaultId) return;
    const vaultKey: string = vaultId;

    disconnect();
    overallDone = false;
    overallError = null;
    overallCancelled = false;
    trigger = undefined;
    backendPhase = "";
    stages = emptyStages();

    const nextController = new AbortController();
    controller = nextController;
    let cancelled = false;
    let terminal = false;

    function handleMessage(message: SseMessage) {
      if (message.event === "connected") return;
      if (message.event === "done") {
        if (!terminal) {
          terminal = true;
          overallError = "Pipeline ended without terminal status";
          invalidateActivePipeline(vaultKey);
        }
        disconnect();
        return;
      }
      if (!message.data) return;

      try {
        const raw = JSON.parse(message.data) as BackendPipelineEvent;
        trigger = raw.trigger ?? trigger;
        backendPhase = raw.phase;
        const data = normalizeEvent(raw);

        if (raw.job_status === "cancelled") {
          terminal = true;
          overallCancelled = true;
          if (data) stages = applyEvent(stages, data);
          invalidateActivePipeline(vaultKey);
          return;
        }
        if (raw.phase_status === "failed" || raw.job_status === "failed") {
          terminal = true;
          overallError = raw.error ?? "Pipeline failed";
          if (data) stages = applyEvent(stages, data);
          invalidateActivePipeline(vaultKey);
          return;
        }
        if (data?.backendPhase === "publish" && data.phase_status === "completed") {
          terminal = true;
          stages = applyEvent(stages, data).map((stage) => ({
            ...stage,
            active: false,
            complete: true,
          }));
          overallDone = true;
          invalidateActivePipeline(vaultKey);
          return;
        }
        if (raw.job_status === "completed") {
          terminal = true;
          overallDone = true;
          invalidateActivePipeline(vaultKey);
        }
        if (data) stages = applyEvent(stages, data);
      } catch {
        // Ignore malformed progress events.
      }
    }

    async function run() {
      let attempt = 0;
      while (!cancelled && !terminal && !nextController.signal.aborted) {
        try {
          const response = await apiFetch(vaultPathFor(vaultKey, `/jobs/${id}/stream`), {
            headers: { Accept: "text/event-stream" },
            signal: nextController.signal,
          });
          if (!response.ok) {
            terminal = true;
            overallError = await response.text();
            return;
          }
          if (!response.body) {
            terminal = true;
            overallError = "Progress stream unavailable";
            return;
          }

          attempt = 0;
          for await (const message of iterateSseMessages(response.body, nextController.signal)) {
            if (cancelled || terminal) break;
            handleMessage(message);
          }
        } catch (error) {
          if (nextController.signal.aborted || terminal || cancelled) {
            return;
          }
          console.warn("Progress stream disconnected; retrying", error);
        }

        if (!cancelled && !terminal && !nextController.signal.aborted) {
          await abortableSleep(retryDelay(attempt), nextController.signal);
          attempt += 1;
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
      nextController.abort();
    };
  });

  return {
    get stages() {
      return stages;
    },
    get overallDone() {
      return overallDone;
    },
    get overallError() {
      return overallError;
    },
    get overallCancelled() {
      return overallCancelled;
    },
    get trigger() {
      return trigger;
    },
    get backendPhase() {
      return backendPhase;
    },
  };
}
