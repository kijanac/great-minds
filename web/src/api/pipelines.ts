import { z } from "zod";

import { apiFetch, readJson, vaultPath } from "./client";

const pipelineRunSchema = z.object({
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
  bulk_task_id: z.string().nullable(),
  compile_intent_id: z.string().nullable(),
  compile_task_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});

export type PipelineRun = z.infer<typeof pipelineRunSchema>;

export async function getCurrentPipeline(): Promise<PipelineRun | null> {
  const res = await apiFetch(vaultPath("/pipelines/current"));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await res.text());
  return readJson(res, pipelineRunSchema);
}

export async function startUrlPipeline(url: string): Promise<PipelineRun> {
  const res = await apiFetch(vaultPath("/pipelines/url"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(await res.text());
  return readJson(res, pipelineRunSchema);
}
