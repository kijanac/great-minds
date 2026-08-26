import { z } from "zod";

import { apiFetch, vaultPath, readJson } from "./client";

export interface IngestResult {
  id: string;
  file_path: string;
}

const ingestResultSchema: z.ZodType<IngestResult> = z.object({
  id: z.string(),
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

export interface UploadFailure {
  name: string;
  error: string;
}

export interface StagedFileUploadProgress {
  phase: StagedFilePhase;
  uploaded: number;
  total: number;
  id?: string;
  error?: string;
  failures?: UploadFailure[];
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
 * The UI hashes files at pick-time and excludes duplicates. This boundary
 * rejects duplicate hashes rather than silently sending fewer files than
 * the confirmed count.
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

  // Reject duplicate hashes at the upload boundary instead of silently
  // collapsing a user-confirmed batch.
  const originalCount = hashedFiles.length;
  const seen = new Set<string>();
  const duplicateFailures: UploadFailure[] = [];
  const uniqueManifest = manifest.filter((manifestItem) => {
    if (seen.has(manifestItem.hash)) {
      duplicateFailures.push({
        name: manifestItem.name,
        error: "Duplicate file content is already selected",
      });
      return false;
    }
    seen.add(manifestItem.hash);
    return true;
  });
  yield { phase: "uploading", uploaded: 0, total: originalCount };
  if (duplicateFailures.length > 0) {
    yield {
      phase: "error",
      uploaded: 0,
      total: originalCount,
      error: "Remove duplicate files before uploading",
      failures: duplicateFailures,
    };
    return;
  }

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

  type ManifestItem = (typeof uniqueManifest)[number];
  type UploadResult =
    | { ok: true; manifestItem: ManifestItem }
    | { ok: false; failure: UploadFailure };

  const uploadResults = await pMap(
    uniqueManifest,
    async (manifestItem): Promise<UploadResult> => {
      const url = urlByHash.get(manifestItem.hash);
      if (!url) {
        return {
          ok: false,
          failure: { name: manifestItem.name, error: "No upload URL was created" },
        };
      }
      const file = fileByHash.get(manifestItem.hash);
      if (!file) {
        return {
          ok: false,
          failure: { name: manifestItem.name, error: "The selected file is unavailable" },
        };
      }
      try {
        const response = await fetch(url, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "application/octet-stream" },
        });
        if (!response.ok) {
          return {
            ok: false,
            failure: {
              name: manifestItem.name,
              error: `Upload returned ${response.status}`,
            },
          };
        }
        return { ok: true, manifestItem };
      } catch (error) {
        return {
          ok: false,
          failure: {
            name: manifestItem.name,
            error: error instanceof Error ? error.message : "Upload failed",
          },
        };
      }
    },
    PUT_CONCURRENCY,
  );

  const failures = uploadResults
    .filter((result): result is Extract<UploadResult, { ok: false }> => !result.ok)
    .map((result) => result.failure);
  const successfullyUploaded = uploadResults
    .filter((result): result is Extract<UploadResult, { ok: true }> => result.ok)
    .map((result) => result.manifestItem);
  yield {
    phase: "uploading",
    uploaded: successfullyUploaded.length,
    total: originalCount,
    failures,
  };

  if (failures.length > 0) {
    yield {
      phase: "error",
      uploaded: successfullyUploaded.length,
      total: originalCount,
      error: `${failures.length} of ${originalCount} files failed to upload`,
      failures,
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
      uploaded: successfullyUploaded.length,
      total: originalCount,
      error: await processRes.text(),
    };
    return;
  }
  const { id } = await readJson(processRes, stagedFileProcessResponseSchema);
  yield {
    phase: "processing",
    uploaded: successfullyUploaded.length,
    total: originalCount,
    id,
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
