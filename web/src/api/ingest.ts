import { z } from "zod";

import { apiFetch, vaultPath, readJson } from "./client";

export interface IngestResult {
  file_path: string;
  title: string;
}

const ingestResultSchema: z.ZodType<IngestResult> = z.object({
  file_path: z.string(),
  title: z.string(),
});

const bulkSignedUrlSchema = z.object({
  hash: z.string(),
  url: z.string(),
});

const bulkSignResponseSchema = z.object({
  files: z.array(bulkSignedUrlSchema),
});

const bulkProcessResponseSchema = z.object({
  task_id: z.string(),
});

const taskStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled"]);

const taskDetailSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: taskStatusSchema,
  created_at: z.string(),
  error: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskDetail = z.infer<typeof taskDetailSchema>;

const PUT_CONCURRENCY = 4;
const TASK_POLL_INTERVAL_MS = 1500;

export type BulkPhase = "uploading" | "processing" | "done" | "error";

export interface BulkUploadProgress {
  phase: BulkPhase;
  uploaded: number;
  total: number;
  task_id?: string;
  error?: string;
  failed_uploads?: { name: string; error: string }[];
}

export async function uploadFile(file: File, destPath?: string): Promise<IngestResult> {
  const formData = new FormData();
  formData.append("file", file);
  if (destPath) {
    formData.append("dest_path", destPath);
  }

  const res = await apiFetch(vaultPath("/ingest/upload"), {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail);
  }

  return readJson(res, ingestResultSchema);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Bulk ingest via direct-to-R2 upload.
 *
 * Yields progress events: per-file "uploading" updates while PUTs are
 * in flight, then a single "processing" event with the spawned task_id,
 * then terminal "done" or "error". Caller drives the rest of the UI off
 * the existing compile-intent stream once the task completes.
 */
export async function* ingestBulk(
  files: File[],
  contentType: string = "texts",
): AsyncGenerator<BulkUploadProgress> {
  if (files.length === 0) return;

  const manifest = await Promise.all(
    files.map(async (f) => ({
      name: f.name,
      size: f.size,
      hash: await sha256Hex(await f.arrayBuffer()),
      mimetype: f.type,
    })),
  );

  // 1. sign
  const signRes = await apiFetch(vaultPath("/ingest/bulk/sign"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files: manifest }),
  });
  if (!signRes.ok) {
    yield {
      phase: "error",
      uploaded: 0,
      total: files.length,
      error: await signRes.text(),
    };
    return;
  }
  const signed = (await readJson(signRes, bulkSignResponseSchema)).files;
  const urlByHash = new Map(signed.map((s) => [s.hash, s.url]));

  // 2. PUT to R2 with bounded concurrency. Per-file failures are
  //    collected; we still kick off /process for whatever uploaded.
  let uploaded = 0;
  const failedUploads: { name: string; error: string }[] = [];
  yield { phase: "uploading", uploaded, total: files.length };

  const uploadResults = await pMap(
    files,
    async (file, i) => {
      const m = manifest[i];
      const url = urlByHash.get(m.hash);
      if (!url) {
        failedUploads.push({ name: file.name, error: "no presigned URL" });
        return null;
      }
      try {
        const res = await fetch(url, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "application/octet-stream" },
        });
        if (!res.ok) {
          failedUploads.push({
            name: file.name,
            error: `PUT ${res.status}: ${await res.text()}`,
          });
          return null;
        }
        return m;
      } catch (e) {
        failedUploads.push({
          name: file.name,
          error: e instanceof Error ? e.message : "PUT failed",
        });
        return null;
      } finally {
        uploaded += 1;
      }
    },
    PUT_CONCURRENCY,
  );

  yield { phase: "uploading", uploaded, total: files.length, failed_uploads: failedUploads };

  const successfullyUploaded = uploadResults.filter(
    (m): m is (typeof manifest)[number] => m !== null,
  );
  if (successfullyUploaded.length === 0) {
    yield {
      phase: "error",
      uploaded,
      total: files.length,
      error: "all uploads failed",
      failed_uploads: failedUploads,
    };
    return;
  }

  // 3. process — spawns the bulk_ingest_from_staging worker task
  const processRes = await apiFetch(vaultPath("/ingest/bulk/process"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      files: successfullyUploaded.map((m) => ({
        hash: m.hash,
        name: m.name,
        mimetype: m.mimetype,
      })),
      content_type: contentType,
      source_type: "document",
    }),
  });
  if (!processRes.ok) {
    yield {
      phase: "error",
      uploaded,
      total: files.length,
      error: await processRes.text(),
      failed_uploads: failedUploads,
    };
    return;
  }
  const { task_id } = await readJson(processRes, bulkProcessResponseSchema);
  yield {
    phase: "processing",
    uploaded,
    total: files.length,
    task_id,
    failed_uploads: failedUploads,
  };

  // 4. poll task to terminal state
  while (true) {
    await new Promise((r) => setTimeout(r, TASK_POLL_INTERVAL_MS));
    const status = await getTask(task_id);
    if (status.status === "completed") {
      yield {
        phase: "done",
        uploaded,
        total: files.length,
        task_id,
        failed_uploads: failedUploads,
      };
      return;
    }
    if (status.status === "failed" || status.status === "cancelled") {
      yield {
        phase: "error",
        uploaded,
        total: files.length,
        task_id,
        error: status.error ?? `task ${status.status}`,
        failed_uploads: failedUploads,
      };
      return;
    }
  }
}

async function getTask(taskId: string): Promise<TaskDetail> {
  const res = await apiFetch(vaultPath(`/tasks/${taskId}`));
  if (!res.ok) throw new Error(await res.text());
  return readJson(res, taskDetailSchema);
}

export type UserSuggestionIntent = "disagree" | "correct" | "add_context" | "restructure";

export async function postUserSuggestion(params: {
  body: string;
  intent: UserSuggestionIntent;
  anchoredTo: string;
  anchoredSection: string;
}): Promise<IngestResult> {
  const res = await apiFetch(vaultPath("/ingest/user-suggestion"), {
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
  const res = await apiFetch(vaultPath("/ingest/url"), {
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
