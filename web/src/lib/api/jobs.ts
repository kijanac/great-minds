import {
  JobProgressSnapshot,
  Uuid,
  type JobPage,
  type JobResponse,
  type PipelineRunFilter,
} from "@great-minds/domain";
import { Filter, Option, Schema, Stream } from "effect";
import type * as Sse from "effect/unstable/encoding/Sse";

import { getVaultId } from "../vault-selection";

import { api, run, stream } from "./app";
import { followUntil } from "./sse";

export type { JobProgressSnapshot, JobResponse };

export type JobEvent =
  | { readonly _tag: "Snapshot"; readonly snapshot: JobProgressSnapshot }
  | { readonly _tag: "Ended" };

const uuid = Schema.decodeSync(Uuid);
const snapshotFromJson = Schema.decodeOption(Schema.fromJsonString(JobProgressSnapshot));

function selectedVault(vaultId?: string): Uuid {
  const id = vaultId ?? getVaultId();
  if (id === null) throw new Error("No vault selected");
  return uuid(id);
}

export function listJobs(status?: PipelineRunFilter, limit = 50, offset = 0): Promise<JobPage> {
  const query = status === undefined ? { limit, offset } : { limit, offset, status };
  return run(api.jobs.listJobs({ params: { vault_id: selectedVault() }, query }));
}

export function startUrlJob(
  url: string,
  jobId: string = crypto.randomUUID(),
): Promise<JobResponse> {
  return run(
    api.jobs.startUrlJob({
      params: { vault_id: selectedVault() },
      payload: { job_id: uuid(jobId), url },
    }),
  );
}

export function retryUrlJob(
  previousJobId: string,
  jobId: string = crypto.randomUUID(),
  vaultId?: string,
): Promise<JobResponse> {
  return run(
    api.jobs.retryUrlJob({
      params: { vault_id: selectedVault(vaultId), job_id: uuid(previousJobId) },
      payload: { job_id: uuid(jobId) },
    }),
  );
}

export function requestCompile(
  jobId: string = crypto.randomUUID(),
  vaultId?: string,
): Promise<JobResponse> {
  return run(
    api.compile.requestCompile({
      params: { vault_id: selectedVault(vaultId) },
      payload: { job_id: uuid(jobId) },
    }),
  );
}

export function cancelJob(runId: string, vaultId?: string): Promise<void> {
  return run(
    api.compile.cancelCompile({
      params: { vault_id: selectedVault(vaultId), run_id: uuid(runId) },
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
  jobId: string,
  vaultId: string,
  signal?: AbortSignal,
): AsyncIterable<JobEvent> {
  const events = Stream.unwrap(
    api.jobs.streamJob({ params: { vault_id: uuid(vaultId), job_id: uuid(jobId) } }),
  ).pipe(Stream.filterMap(Filter.fromPredicateOption(toJobEvent)));
  return stream(followUntil(events, isTerminal), signal);
}
