import { z } from "zod";

import { pageInfoSchema } from "./schemas";
import { apiFetch, readJson, vaultPath } from "./client";

export const jobSchema = z.object({
  id: z.string(),
  vault_id: z.string(),
  trigger: z.string(),
  status: z.string(),
  current_phase: z.string(),
  phase_status: z.string(),
  progress_done: z.number(),
  progress_total: z.number(),
  progress_failed: z.number(),
  progress_message: z.string(),
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
