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

const stagedFileSignedUrlSchema = z.object({
  hash: z.string(),
  url: z.string(),
});

const stagedFileSignResponseSchema = z.object({
  files: z.array(stagedFileSignedUrlSchema),
});

const stagedFileProcessResponseSchema = z.object({
  id: z.string(),
  stream_url: z.string(),
});

const PUT_CONCURRENCY = 4;

export type StagedFilePhase = "uploading" | "processing" | "done" | "error";

export interface StagedFileUploadProgress {
  phase: StagedFilePhase;
  uploaded: number;
  total: number;
  id?: string;
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
  const results: R[] = Array.from({ length: items.length });
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
 * Ingest one or more files via direct-to-R2 staged upload.
 *
 * Yields progress events: per-file "uploading" updates while PUTs are
 * in flight, then a single "processing" event with the durable job_id.
 * Caller drives backend progress from the job SSE stream.
 */
export async function* ingestStagedFiles(
  files: File[],
  contentType: string = "texts",
  jobId: string = crypto.randomUUID(),
): AsyncGenerator<StagedFileUploadProgress> {
  if (files.length === 0) return;

  // Build manifest with bounded concurrency so we don't exhaust browser
  // file handles or memory when reading thousands of files at once.
  const manifest = await pMap(
    files,
    async (f) => ({
      name: f.name,
      size: f.size,
      hash: await sha256Hex(await f.arrayBuffer()),
      mimetype: f.type,
    }),
    PUT_CONCURRENCY,
  );

  // Deduplicate by content hash before uploading — identical files
  // (e.g. scrape failures) would produce the same dest path and cause
  // Postgres ON CONFLICT errors in the worker.
  const originalCount = files.length;
  const seen = new Set<string>();
  const uniqueManifest = manifest.filter((m) => {
    if (seen.has(m.hash)) return false;
    seen.add(m.hash);
    return true;
  });
  const skippedDuplicate = originalCount - uniqueManifest.length;
  yield {
    phase: "uploading",
    uploaded: 0,
    total: originalCount,
    ...(skippedDuplicate > 0 ? { skipped_duplicate: skippedDuplicate } : {}),
  };

  // 1. sign (unique hashes only)
  const signRes = await apiFetch(vaultPath("/ingest/staged-files/sign"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files: uniqueManifest }),
  });
  if (!signRes.ok) {
    yield {
      phase: "error",
      uploaded: 0,
      total: originalCount,
      error: await signRes.text(),
    };
    return;
  }
  const signed = (await readJson(signRes, stagedFileSignResponseSchema)).files;
  const urlByHash = new Map(signed.map((s) => [s.hash, s.url]));

  // 2. PUT to R2 (unique files only, one per hash).
  //    Build a hash→File map from the original file list for upload.
  const fileByHash = new Map<string, File>();
  for (let i = 0; i < manifest.length; i++) {
    if (!fileByHash.has(manifest[i].hash)) {
      fileByHash.set(manifest[i].hash, files[i]);
    }
  }

  let uploaded = 0;
  const failedUploads: { name: string; error: string }[] = [];
  yield { phase: "uploading", uploaded, total: originalCount };

  const uploadResults = await pMap(
    uniqueManifest,
    async (m) => {
      const url = urlByHash.get(m.hash);
      if (!url) {
        failedUploads.push({ name: m.name, error: "no presigned URL" });
        return null;
      }
      const file = fileByHash.get(m.hash);
      if (!file) {
        failedUploads.push({ name: m.name, error: "file not found" });
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
            name: m.name,
            error: `PUT ${res.status}: ${await res.text()}`,
          });
          return null;
        }
        return m;
      } catch (e) {
        failedUploads.push({
          name: m.name,
          error: e instanceof Error ? e.message : "PUT failed",
        });
        return null;
      } finally {
        uploaded += 1;
      }
    },
    PUT_CONCURRENCY,
  );

  yield { phase: "uploading", uploaded, total: originalCount, failed_uploads: failedUploads };

  const successfullyUploaded = uploadResults.filter(
    (m): m is (typeof uniqueManifest)[number] => m !== null,
  );
  if (successfullyUploaded.length === 0) {
    yield {
      phase: "error",
      uploaded,
      total: originalCount,
      error: "all uploads failed",
      failed_uploads: failedUploads,
    };
    return;
  }

  // 3. process — spawns/reuses the staged-file ingest worker task.
  // The client-generated job ID is the public job ID, SSE channel,
  // and Absurd idempotency key on the backend.
  const processRes = await apiFetch(vaultPath("/ingest/staged-files/process"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id: jobId,
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
      total: originalCount,
      error: await processRes.text(),
      failed_uploads: failedUploads,
    };
    return;
  }
  const { id } = await readJson(processRes, stagedFileProcessResponseSchema);
  yield {
    phase: "processing",
    uploaded,
    total: originalCount,
    id,
    failed_uploads: failedUploads,
  };

  return;
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
