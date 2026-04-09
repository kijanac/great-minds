import { z } from "zod";

import { apiFetch, readJson } from "./client";

export interface IngestResult {
  status: string;
  name: string;
  chars: number;
}

const ingestResultSchema: z.ZodType<IngestResult> = z.object({
  status: z.string(),
  name: z.string(),
  chars: z.number(),
});

export async function uploadFile(file: File, destPath?: string): Promise<IngestResult> {
  const formData = new FormData();
  formData.append("file", file);
  if (destPath) {
    formData.append("dest_path", destPath);
  }

  const res = await apiFetch("/ingest/upload", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail);
  }

  return readJson(res, ingestResultSchema);
}

export async function compile(): Promise<void> {
  const res = await apiFetch("/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    console.warn("compile trigger failed:", res.status);
  }
}

export async function ingestUrl(url: string): Promise<IngestResult> {
  const res = await apiFetch("/ingest/url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail);
  }

  return readJson(res, ingestResultSchema);
}
