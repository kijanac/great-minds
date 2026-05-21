import { z } from "zod";

import { pageInfoSchema } from "./schemas";
import { apiFetch, readJson, vaultPath } from "./client";

const progressStepSchema = z.object({
  key: z.string(),
  label: z.string(),
  status: z.enum(["pending", "running", "completed", "failed"]),
  done: z.number().nullable(),
  total: z.number().nullable(),
  detail: z.string(),
});

export const jobSchema = z.object({
  id: z.string(),
  vault_id: z.string(),
  trigger: z.string(),
  status: z.string(),
  current_phase: z.string(),
  phase_status: z.string(),
  progress_steps: z.array(progressStepSchema),
  error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
  stream_url: z.string(),
});

export type Job = z.infer<typeof jobSchema>;

const jobPageSchema = z.object({
  items: z.array(jobSchema),
  pagination: pageInfoSchema,
});

export type JobPage = z.infer<typeof jobPageSchema>;

export async function listJobs(
  status?: "active",
  limit: number = 50,
  offset: number = 0,
): Promise<JobPage> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (status) params.set("status", status);
  const res = await apiFetch(vaultPath(`/jobs?${params.toString()}`));
  if (!res.ok) throw new Error(await res.text());
  return readJson(res, jobPageSchema);
}

export async function startUrlJob(url: string, jobId: string = crypto.randomUUID()): Promise<Job> {
  const res = await apiFetch(vaultPath("/jobs/url"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, url }),
  });
  if (!res.ok) throw new Error(await res.text());
  return readJson(res, jobSchema);
}

/** Re-run the compile for this vault (sources already ingested; content-hash
 *  caches make it resume cheaply). Returns the new job to follow. */
export async function requestCompile(jobId: string = crypto.randomUUID()): Promise<Job> {
  const res = await apiFetch(vaultPath("/compile"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return readJson(res, jobSchema);
}

export async function cancelJob(runId: string): Promise<void> {
  const res = await apiFetch(vaultPath(`/compile/${runId}/cancel`), { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
}
