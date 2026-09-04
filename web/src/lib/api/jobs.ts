import {
  JobProgressSnapshot,
  type JobPage,
  type JobResponse,
  type PipelineRunFilter,
  type Uuid,
} from "@great-minds/domain";
import { Filter, Option, Schema, Stream } from "effect";
import type * as Sse from "effect/unstable/encoding/Sse";

import { newUuid } from "../ids";

import { api, run, stream } from "./app";
import { selectedVault } from "./selected-vault";
import { followUntil } from "./sse";

export type { JobProgressSnapshot, JobResponse };

export type JobEvent =
  | { readonly _tag: "Snapshot"; readonly snapshot: JobProgressSnapshot }
  | { readonly _tag: "Ended" };

const snapshotFromJson = Schema.decodeOption(Schema.fromJsonString(JobProgressSnapshot));

export function listJobs(status?: PipelineRunFilter, limit = 50, offset = 0): Promise<JobPage> {
  const query = status === undefined ? { limit, offset } : { limit, offset, status };
  return run(api.jobs.listJobs({ params: { vault_id: selectedVault() }, query }));
}

export function startUrlJob(url: string, jobId: Uuid = newUuid()): Promise<JobResponse> {
  return run(
    api.jobs.startUrlJob({
      params: { vault_id: selectedVault() },
      payload: { job_id: jobId, url },
    }),
  );
}

export function retryUrlJob(
  previousJobId: Uuid,
  jobId: Uuid = newUuid(),
  vaultId?: Uuid,
): Promise<JobResponse> {
  return run(
    api.jobs.retryUrlJob({
      params: { vault_id: selectedVault(vaultId), job_id: previousJobId },
      payload: { job_id: jobId },
    }),
  );
}

export function requestCompile(jobId: Uuid = newUuid(), vaultId?: Uuid): Promise<JobResponse> {
  return run(
    api.compile.requestCompile({
      params: { vault_id: selectedVault(vaultId) },
      payload: { job_id: jobId },
    }),
  );
}

export function cancelJob(runId: Uuid, vaultId?: Uuid): Promise<void> {
  return run(
    api.compile.cancelCompile({
      params: { vault_id: selectedVault(vaultId), run_id: runId },
    }),
  );
}

const toJobEvent = (event: Sse.EventEncoded): Option.Option<JobEvent> => {
  if (event.event === "done") return Option.some({ _tag: "Ended" });
  if (event.event !== "message" || event.data.length === 0) return Option.none();
  return Option.map(snapshotFromJson(event.data), (snapshot) => ({ _tag: "Snapshot", snapshot }));
};

const terminalSnapshot = (snapshot: JobProgressSnapshot) =>
  snapshot.job_status !== "pending" && snapshot.job_status !== "running"
    ? true
    : snapshot.phase_status === "failed" ||
      (snapshot.phase === "publish" && snapshot.phase_status === "completed");

const isTerminal = (event: JobEvent) => event._tag === "Ended" || terminalSnapshot(event.snapshot);

export function followJob(
  jobId: Uuid,
  vaultId: Uuid,
  signal?: AbortSignal,
): AsyncIterable<JobEvent> {
  const events = Stream.unwrap(
    api.jobs.streamJob({ params: { vault_id: vaultId, job_id: jobId } }),
  ).pipe(Stream.filterMap(Filter.fromPredicateOption(toJobEvent)));
  return stream(followUntil(events, isTerminal), signal);
}
