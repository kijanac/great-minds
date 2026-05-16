import { z } from "zod";

import { apiFetch, vaultPath, readJson } from "./client";

export interface IngestResult {
  file_path: string;
}

const ingestResultSchema: z.ZodType<IngestResult> = z.object({
  file_path: z.string(),
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

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 of a File's raw bytes. Used by the ingest UI at pick time
 *  to detect duplicates within the current batch and against the vault. */
export async function hashFile(file: File): Promise<string> {
  return sha256Hex(await file.arrayBuffer());
}

const checkDupesResponseSchema = z.object({
  existing: z.array(z.string()),
});

/** Pre-flight: which of these client hashes already exist in the vault? */
export async function checkDupes(clientHashes: string[]): Promise<Set<string>> {
  if (clientHashes.length === 0) return new Set();
  const res = await apiFetch(vaultPath("/ingest/staged-files/check-dupes"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_hashes: clientHashes }),
  });
  if (!res.ok) {
    // Soft-fail: the pre-flight is an enhancement, not a hard
    // requirement. Surface dup-in-vault as unknown rather than
    // blocking the upload flow.
    return new Set();
  }
  const { existing } = await readJson(res, checkDupesResponseSchema);
  return new Set(existing);
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

/** One file paired with its client-computed SHA-256 hash. */
export interface HashedFile {
  file: File;
  hash: string;
}

/**
 * Ingest pre-hashed files via direct-to-R2 staged upload.
 *
 * The UI is expected to have already hashed at pick-time and (for the
 * current preview UX) excluded duplicates. A defensive within-batch
 * dedupe still runs here so legacy callers can't accidentally send
 * conflicting hashes.
 *
 * Yields progress events: per-file "uploading" updates while PUTs are
 * in flight, then a single "processing" event with the durable job_id.
 * Caller drives backend progress from the job SSE stream.
 */
export async function* ingestStagedFiles(
  hashedFiles: HashedFile[],
  jobId: string = crypto.randomUUID(),
): AsyncGenerator<StagedFileUploadProgress> {
  if (hashedFiles.length === 0) return;

  const manifest = hashedFiles.map(({ file, hash }) => ({
    name: file.name,
    size: file.size,
    hash,
    mimetype: file.type,
  }));

  // Defensive within-batch dedupe — the UI is supposed to have done
  // this already, but the cost is one hash-set scan.
  const originalCount = hashedFiles.length;
  const seen = new Set<string>();
  const uniqueManifest = manifest.filter((m) => {
    if (seen.has(m.hash)) return false;
    seen.add(m.hash);
    return true;
  });
  yield { phase: "uploading", uploaded: 0, total: originalCount };

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
  const fileByHash = new Map<string, File>();
  for (const { file, hash } of hashedFiles) {
    if (!fileByHash.has(hash)) fileByHash.set(hash, file);
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
        size: m.size,
        mimetype: m.mimetype,
      })),
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
