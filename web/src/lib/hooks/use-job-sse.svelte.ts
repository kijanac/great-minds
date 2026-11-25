import type { JobProgressSnapshot, Uuid } from "@great-minds/domain";
import { useQueryClient } from "@tanstack/svelte-query";

import { errorMessage } from "@great-minds/client";
import { followJob } from "#lib/api/jobs.ts";
import { activeVault } from "#lib/hooks/use-vault.svelte.ts";

export function useJobSSE(
  jobId: () => Uuid | null,
  jobVaultId: () => Uuid | null = () => activeVault.id,
) {
  const queryClient = useQueryClient();
  let snapshot = $state<JobProgressSnapshot | null>(null);
  let streamError = $state<string | null>(null);
  let connection = $state(0);
  let followed: Uuid | null = null;
  const terminal = $derived.by(() => {
    const status = snapshot?.job_status;
    if (status === "cancelled") return status;
    if (status === "failed" || snapshot?.phase_status === "failed") return "failed";
    if (
      status === "completed" ||
      (snapshot?.phase === "publish" && snapshot.phase_status === "completed")
    )
      return "completed";
    return null;
  });

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
      if (ended && terminal === null) streamError = "Progress stream ended before the run finished";
      void queryClient.invalidateQueries({
        queryKey: ["vault", vaultKey, "active-job"],
      });
    }

    void follow();
    return () => controller.abort();
  });

  $effect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && terminal === null) connection += 1;
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  });

  return {
    get track() {
      return snapshot?.track ?? [];
    },
    get outcome() {
      return snapshot?.outcome ?? null;
    },
    get running() {
      return snapshot !== null && terminal === null;
    },
    get startedAt() {
      return snapshot?.created_at ?? null;
    },
    get completedAt() {
      return snapshot?.completed_at ?? null;
    },
    get warned() {
      return (snapshot?.warnings.length ?? 0) > 0;
    },
    get overallDone() {
      return terminal === "completed";
    },
    get overallError() {
      return terminal === "failed" ? (snapshot?.error ?? "Pipeline failed") : null;
    },
    get overallCancelled() {
      return terminal === "cancelled";
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
