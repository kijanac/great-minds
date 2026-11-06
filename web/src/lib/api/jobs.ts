import {
  type JobProgressSnapshot,
  type JobPage,
  type JobResponse,
  type PipelineRunFilter,
  type Uuid,
} from "@great-minds/domain";
import { followJob as followJobSnapshots, newUuid } from "@great-minds/client";

import { api, run, stream } from "./app";
import { selectedVault } from "./selected-vault";

export type { JobProgressSnapshot, JobResponse };

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

export function followJob(
  jobId: Uuid,
  vaultId: Uuid,
  signal?: AbortSignal,
): AsyncIterable<JobProgressSnapshot> {
  return stream(followJobSnapshots(api, vaultId, jobId), signal);
}
