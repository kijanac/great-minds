import type { JobProgressSnapshot, PipelineProgressStep } from "@great-minds/domain";
import { useQueryClient } from "@tanstack/svelte-query";

import { errorMessage } from "$lib/api/errors";
import { followJob } from "$lib/api/jobs";
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

export type ProgressStep = PipelineProgressStep;
export type ProgressStepStatus = ProgressStep["status"];

export interface StageProgress {
  stage: PipelineStage;
  label: string;
  detail: string;
  done: number;
  total: number;
  steps: readonly ProgressStep[];
  active: boolean;
  complete: boolean;
  errored: boolean;
}

interface PipelineEvent {
  backendPhase: BackendPhase;
  phase: PipelineStage;
  phase_status: string;
  steps: readonly ProgressStep[];
  error?: string;
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

const isBackendPhase = (phase: string): phase is BackendPhase => phase in PHASE_TO_STAGE;

function normalizeEvent(snapshot: JobProgressSnapshot): PipelineEvent | null {
  if (!isBackendPhase(snapshot.phase)) return null;
  return {
    backendPhase: snapshot.phase,
    phase: PHASE_TO_STAGE[snapshot.phase],
    phase_status: snapshot.phase_status,
    steps: snapshot.steps,
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  };
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
  let trigger = $state<JobProgressSnapshot["trigger"] | undefined>(undefined);
  let backendPhase = $state("");

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
    const jobKey: string = id;

    overallDone = false;
    overallError = null;
    overallCancelled = false;
    trigger = undefined;
    backendPhase = "";
    stages = emptyStages();

    const controller = new AbortController();
    let terminal = false;

    function applySnapshot(snapshot: JobProgressSnapshot) {
      trigger = snapshot.trigger;
      backendPhase = snapshot.phase;
      const data = normalizeEvent(snapshot);

      if (snapshot.job_status === "cancelled") {
        terminal = true;
        overallCancelled = true;
        if (data) stages = applyEvent(stages, data);
        invalidateActivePipeline(vaultKey);
        return;
      }
      if (snapshot.phase_status === "failed" || snapshot.job_status === "failed") {
        terminal = true;
        overallError = snapshot.error ?? "Pipeline failed";
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
      if (snapshot.job_status === "completed") {
        terminal = true;
        overallDone = true;
        invalidateActivePipeline(vaultKey);
      }
      if (data) stages = applyEvent(stages, data);
    }

    async function follow() {
      try {
        for await (const event of followJob(jobKey, vaultKey, controller.signal)) {
          if (event._tag === "Ended") {
            if (!terminal) {
              terminal = true;
              overallError = "Pipeline ended without terminal status";
              invalidateActivePipeline(vaultKey);
            }
            return;
          }
          applySnapshot(event.snapshot);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        terminal = true;
        overallError = errorMessage(error, "Progress stream unavailable");
        invalidateActivePipeline(vaultKey);
      }
    }

    void follow();
    return () => {
      controller.abort();
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
