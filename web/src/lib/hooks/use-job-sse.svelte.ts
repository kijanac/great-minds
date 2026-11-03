import type {
  JobProgressSnapshot,
  PipelineProgressStep,
  PipelineWarning,
  Uuid,
} from "@great-minds/domain";
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
  warnings: readonly PipelineWarning[];
  active: boolean;
  complete: boolean;
  errored: boolean;
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

const isBackendPhase = (phase: string): phase is BackendPhase => phase in PHASE_TO_STAGE;

const runningDetail = (step: ProgressStep | undefined) =>
  step === undefined
    ? ""
    : step.detail ||
      (step.total && step.total > 0 && step.done != null
        ? `${step.label} ${step.done} of ${step.total}…`
        : `${step.label}…`);

export function stagesFrom(snapshot: JobProgressSnapshot | null): StageProgress[] {
  const current =
    snapshot !== null && isBackendPhase(snapshot.phase) ? PHASE_TO_STAGE[snapshot.phase] : null;
  const currentIndex = STAGES.findIndex((stage) => stage.stage === current);
  const finished = snapshot?.job_status === "completed";
  const stepsOf = new Map<PipelineStage, readonly ProgressStep[]>();
  for (const stored of snapshot?.stages ?? [])
    if (isBackendPhase(stored.phase)) stepsOf.set(PHASE_TO_STAGE[stored.phase], stored.steps);
  return STAGES.map(({ stage, label }, index) => {
    const steps = stepsOf.get(stage) ?? [];
    const isCurrent = index === currentIndex;
    const failed = isCurrent && snapshot?.phase_status === "failed";
    const complete =
      finished ||
      (currentIndex !== -1 && index < currentIndex) ||
      (isCurrent && snapshot?.phase_status === "completed");
    const active = isCurrent && !complete && !failed && snapshot?.job_status !== "cancelled";
    const running = active ? steps.find((step) => step.status === "running") : undefined;
    const warnings = (snapshot?.warnings ?? []).filter(
      (warning) => isBackendPhase(warning.phase) && PHASE_TO_STAGE[warning.phase] === stage,
    );
    return {
      stage,
      label,
      detail: failed ? (snapshot?.error ?? "") : runningDetail(running),
      done: running?.done ?? 0,
      total: running?.total && running.total > 0 ? running.total : 1,
      steps,
      warnings,
      active,
      complete,
      errored: failed,
    };
  });
}

export function useJobSSE(
  jobId: () => Uuid | null,
  jobVaultId: () => Uuid | null = () => activeVault.id,
) {
  const queryClient = useQueryClient();
  let snapshot = $state<JobProgressSnapshot | null>(null);
  let streamError = $state<string | null>(null);
  let connection = $state(0);
  let followed: Uuid | null = null;
  const status = $derived(snapshot?.job_status);
  const failed = $derived(status === "failed" || snapshot?.phase_status === "failed");
  const done = $derived(
    status === "completed" ||
      (snapshot?.phase === "publish" && snapshot.phase_status === "completed"),
  );
  const terminal = $derived(failed || done || status === "cancelled");

  $effect(() => {
    const id = jobId();
    const vaultId = jobVaultId();
    void connection;
    if (!id || !vaultId) return;
    const vaultKey = vaultId;
    if (followed !== id) {
      followed = id;
      snapshot = null;
    }
    streamError = null;
    const controller = new AbortController();
    let ended = false;

    async function follow() {
      try {
        for await (const next of followJob(id!, vaultKey, controller.signal)) {
          snapshot = next;
        }
        ended = true;
      } catch (error) {
        if (controller.signal.aborted) return;
        streamError = errorMessage(error, "Progress stream unavailable");
      }
      if (controller.signal.aborted) return;
      if (ended && !terminal) streamError = "Progress stream ended before the run finished";
      void queryClient.invalidateQueries({ queryKey: ["vault", vaultKey, "active-job"] });
    }

    void follow();
    return () => controller.abort();
  });

  $effect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && !terminal) connection += 1;
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  });

  return {
    get stages() {
      return stagesFrom(snapshot);
    },
    get warned() {
      return (snapshot?.warnings.length ?? 0) > 0;
    },
    get overallDone() {
      return done && !failed;
    },
    get overallError() {
      return failed ? (snapshot?.error ?? "Pipeline failed") : null;
    },
    get overallCancelled() {
      return status === "cancelled";
    },
    get streamError() {
      return streamError;
    },
    reconnect() {
      connection += 1;
    },
    get trigger() {
      return snapshot?.trigger;
    },
    get backendPhase() {
      return snapshot?.phase ?? "";
    },
  };
}
