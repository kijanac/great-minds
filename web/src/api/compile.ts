import { z } from "zod";

import { apiFetch, vaultPath, readJson } from "./client";

export type IntentStatus = "pending" | "dispatched" | "satisfied";

export interface CompileIntent {
  id: string;
  vault_id: string;
  created_at: string;
  dispatched_at: string | null;
  dispatched_task_id: string | null;
  satisfied_at: string | null;
  status: IntentStatus;
}

const compileIntentSchema: z.ZodType<CompileIntent> = z.object({
  id: z.string(),
  vault_id: z.string(),
  created_at: z.string(),
  dispatched_at: z.string().nullable(),
  dispatched_task_id: z.string().nullable(),
  satisfied_at: z.string().nullable(),
  status: z.enum(["pending", "dispatched", "satisfied"]),
});

export async function compile(): Promise<CompileIntent> {
  const res = await apiFetch(vaultPath("/compile"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail);
  }
  return readJson(res, compileIntentSchema);
}

export async function getCompileIntent(intentId: string): Promise<CompileIntent> {
  const res = await apiFetch(vaultPath(`/compile/${intentId}`));
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail);
  }
  return readJson(res, compileIntentSchema);
}
