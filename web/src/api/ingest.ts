import { z } from "zod";

import { apiFetch, brainPath, readJson } from "./client";

export interface IngestResult {
  file_path: string;
  title: string;
}

const ingestResultSchema: z.ZodType<IngestResult> = z.object({
  file_path: z.string(),
  title: z.string(),
});

const bulkStartEventSchema = z.object({
  event: z.literal("start"),
  total: z.number(),
});

const bulkFileEventSchema = z.object({
  event: z.literal("file"),
  index: z.number(),
  filename: z.string(),
  status: z.enum(["done", "skipped", "error"]),
  file_path: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

const bulkDoneEventSchema = z.object({
  event: z.literal("done"),
  ingested: z.number(),
  skipped: z.number(),
  failed: z.number(),
  compile_intent_id: z.string().nullable(),
});

const bulkEventSchema = z.discriminatedUnion("event", [
  bulkStartEventSchema,
  bulkFileEventSchema,
  bulkDoneEventSchema,
]);

export type BulkStartEvent = z.infer<typeof bulkStartEventSchema>;
export type BulkFileEvent = z.infer<typeof bulkFileEventSchema>;
export type BulkDoneEvent = z.infer<typeof bulkDoneEventSchema>;
export type BulkEvent = z.infer<typeof bulkEventSchema>;

export async function uploadFile(file: File, destPath?: string): Promise<IngestResult> {
  const formData = new FormData();
  formData.append("file", file);
  if (destPath) {
    formData.append("dest_path", destPath);
  }

  const res = await apiFetch(brainPath("/ingest/upload"), {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail);
  }

  return readJson(res, ingestResultSchema);
}

export type IntentStatus = "pending" | "dispatched" | "satisfied";

export interface CompileIntent {
  id: string;
  brain_id: string;
  created_at: string;
  dispatched_at: string | null;
  dispatched_task_id: string | null;
  satisfied_at: string | null;
  status: IntentStatus;
}

const compileIntentSchema: z.ZodType<CompileIntent> = z.object({
  id: z.string(),
  brain_id: z.string(),
  created_at: z.string(),
  dispatched_at: z.string().nullable(),
  dispatched_task_id: z.string().nullable(),
  satisfied_at: z.string().nullable(),
  status: z.enum(["pending", "dispatched", "satisfied"]),
});

export async function compile(): Promise<CompileIntent> {
  const res = await apiFetch(brainPath("/compile"), {
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
  const res = await apiFetch(brainPath(`/compile/${intentId}`));
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail);
  }
  return readJson(res, compileIntentSchema);
}

export async function* ingestBulk(
  files: File[],
  contentType: string = "texts",
): AsyncGenerator<BulkEvent> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }
  formData.append("content_type", contentType);

  const res = await apiFetch(brainPath("/ingest/bulk"), {
    method: "POST",
    body: formData,
  });

  if (!res.ok || !res.body) {
    const detail = res.ok ? "Empty response body" : await res.text();
    throw new Error(detail);
  }

  for await (const line of readLines(res.body)) {
    if (!line) continue;
    yield bulkEventSchema.parse(JSON.parse(line));
  }
}

async function* readLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        yield buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
      }
    }
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

export type UserSuggestionIntent =
  | "disagree"
  | "correct"
  | "add_context"
  | "restructure";

export async function postUserSuggestion(params: {
  body: string;
  intent: UserSuggestionIntent;
  anchoredTo: string;
  anchoredSection: string;
}): Promise<IngestResult> {
  const res = await apiFetch(brainPath("/ingest/user-suggestion"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      body: params.body,
      intent: params.intent,
      anchored_to: params.anchoredTo,
      anchored_section: params.anchoredSection,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail);
  }

  return readJson(res, ingestResultSchema);
}

export async function ingestUrl(url: string): Promise<IngestResult> {
  const res = await apiFetch(brainPath("/ingest/url"), {
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
