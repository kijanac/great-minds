import { apiFetch, vaultPath, readJson } from "./client";
import { jobSchema, type Job } from "./jobs";

/** Request a compile and return the user-visible job. */
export async function compile(jobId: string = crypto.randomUUID()): Promise<Job> {
  const res = await apiFetch(vaultPath("/compile"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail);
  }
  return readJson(res, jobSchema);
}
