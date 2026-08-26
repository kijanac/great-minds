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

const fileFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

const fileIngestUploadTargetSchema = z.discriminatedUnion("transport", [
  z.object({
    hash: fileFingerprintSchema,
    transport: z.literal("api"),
  }),
  z.object({
    hash: fileFingerprintSchema,
    transport: z.literal("presigned"),
    url: z.string(),
  }),
]);

const fileIngestFileSchema = z.object({
  name: z.string(),
  size: z.number(),
  hash: fileFingerprintSchema,
  mimetype: z.string(),
  status: z.enum(["pending", "uploaded", "processing", "completed", "failed", "cancelled"]),
  error: z.string().nullable(),
});

const fileIngestBatchSchema = z.object({
  id: z.string(),
  vault_id: z.string(),
  created_by: z.string(),
  status: z.enum(["uploading", "processing", "completed", "failed", "cancelled"]),
  error: z.string().nullable(),
  expires_at: z.string(),
  files: z.array(fileIngestFileSchema),
  targets: z.array(fileIngestUploadTargetSchema),
});

const fileIngestCommitSchema = z.object({
  id: z.string(),
  stream_url: z.string(),
});

export type FileIngestBatch = z.infer<typeof fileIngestBatchSchema>;
export type FileIngestUploadTarget = z.infer<typeof fileIngestUploadTargetSchema>;

const PUT_CONCURRENCY = 4;

export type FileIngestPhase = "uploading" | "processing" | "error";

export interface UploadFailure {
  name: string;
  error: string;
}

export interface FileIngestProgress {
  phase: FileIngestPhase;
  uploaded: number;
  total: number;
  id?: string;
  batch?: FileIngestBatch;
  error?: string;
  failures?: UploadFailure[];
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 of a File's original bytes for review and advisory duplicate checks. */
export async function hashFile(file: File): Promise<string> {
  return sha256Hex(await file.arrayBuffer());
}

const checkDupesResponseSchema = z.object({
  existing: z.array(z.string()),
});

/** Pre-flight: which of these client hashes already exist in the active vault? */
export async function checkDupes(clientHashes: string[]): Promise<Set<string>> {
  if (clientHashes.length === 0) return new Set();
  const res = await apiFetch(vaultPath("/file-ingests/check-dupes"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_hashes: clientHashes }),
  });
  if (!res.ok) return new Set();
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
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** One browser File paired with its client-computed raw-byte SHA-256. */
export interface HashedFile {
  file: File;
  hash: string;
}

export const hashFiles = (files: File[]): Promise<HashedFile[]> =>
  pMap(files, async (file) => ({ file, hash: await hashFile(file) }), PUT_CONCURRENCY);

const batchPath = (batchId: string, suffix = "") => `/file-ingests/${batchId}${suffix}`;

const errorText = async (response: Response) => {
  const text = await response.text();
  return text || `Request returned ${response.status}`;
};

const manifestFor = (hashedFiles: HashedFile[]) =>
  hashedFiles.map(({ file, hash }) => ({
    name: file.name,
    size: file.size,
    hash,
    mimetype: file.type,
  }));

export async function createFileIngestBatch(
  hashedFiles: HashedFile[],
  batchId: string = crypto.randomUUID(),
): Promise<FileIngestBatch> {
  const res = await apiFetch(vaultPath("/file-ingests"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batch_id: batchId, files: manifestFor(hashedFiles) }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return readJson(res, fileIngestBatchSchema);
}

export async function getFileIngestBatch(batchId: string): Promise<FileIngestBatch | null> {
  const res = await apiFetch(batchPath(batchId));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await errorText(res));
  return readJson(res, fileIngestBatchSchema);
}

export async function resumeFileIngestBatch(batchId: string): Promise<FileIngestBatch> {
  const res = await apiFetch(batchPath(batchId, "/resume"), { method: "POST" });
  if (!res.ok) throw new Error(await errorText(res));
  return readJson(res, fileIngestBatchSchema);
}

const uploadFile = (batchId: string, file: File, hash: string) => {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch(batchPath(batchId, `/files/${hash}`), {
    method: "POST",
    body: formData,
  });
};

const acknowledgeUpload = (batchId: string, hash: string) =>
  apiFetch(batchPath(batchId, `/files/${hash}/complete`), { method: "POST" });

const commitFileIngest = async (batchId: string) => {
  const res = await apiFetch(batchPath(batchId, "/commit"), { method: "POST" });
  if (!res.ok) throw new Error(await errorText(res));
  return readJson(res, fileIngestCommitSchema);
};

/**
 * Transfers only the files still missing from a durable batch, acknowledges each
 * successful object, then commits the immutable manifest for worker processing.
 * Uploaded receipts survive navigation and API restarts; missing browser File
 * objects are reported by name so the user can reselect them.
 */
export async function* continueFileIngest(
  initialBatch: FileIngestBatch,
  hashedFiles: HashedFile[],
): AsyncGenerator<FileIngestProgress> {
  let batch = initialBatch;
  const total = batch.files.length;
  const received = () => batch.files.filter((file) => file.status !== "pending").length;

  if (batch.status === "processing" || batch.status === "completed") {
    yield { phase: "processing", uploaded: total, total, id: batch.id, batch };
    return;
  }
  if (batch.status === "failed" || batch.status === "cancelled") {
    yield {
      phase: "error",
      uploaded: received(),
      total,
      batch,
      error: batch.error ?? `File ingest is ${batch.status}`,
    };
    return;
  }

  if (batch.targets.length === 0 && batch.files.some((file) => file.status === "pending")) {
    batch = await resumeFileIngestBatch(batch.id);
  }
  yield { phase: "uploading", uploaded: received(), total, batch };

  const fileByHash = new Map(hashedFiles.map(({ file, hash }) => [hash, file]));
  type UploadResult = { ok: true; hash: string } | { ok: false; failure: UploadFailure };

  const results = await pMap(
    batch.targets,
    async (target): Promise<UploadResult> => {
      const manifestFile = batch.files.find((file) => file.hash === target.hash);
      const file = fileByHash.get(target.hash);
      if (!manifestFile || !file) {
        return {
          ok: false,
          failure: {
            name: manifestFile?.name ?? target.hash,
            error: "Reselect this file to continue",
          },
        };
      }
      try {
        const contentType = file.type || "application/octet-stream";
        const response =
          target.transport === "presigned"
            ? await fetch(target.url, {
                method: "PUT",
                body: file,
                headers: { "Content-Type": contentType },
              })
            : await uploadFile(batch.id, file, target.hash);
        if (!response.ok) {
          return {
            ok: false,
            failure: {
              name: manifestFile.name,
              error: `Upload returned ${response.status}`,
            },
          };
        }
        const acknowledged = await acknowledgeUpload(batch.id, target.hash);
        if (!acknowledged.ok) {
          return {
            ok: false,
            failure: {
              name: manifestFile.name,
              error: `Upload acknowledgement returned ${acknowledged.status}`,
            },
          };
        }
        return { ok: true, hash: target.hash };
      } catch (error) {
        return {
          ok: false,
          failure: {
            name: manifestFile.name,
            error: error instanceof Error ? error.message : "Upload failed",
          },
        };
      }
    },
    PUT_CONCURRENCY,
  );

  const uploadedNow = results.filter((result) => result.ok).length;
  const failures = results
    .filter((result): result is Extract<UploadResult, { ok: false }> => !result.ok)
    .map((result) => result.failure);
  const uploaded = Math.min(total, received() + uploadedNow);
  yield { phase: "uploading", uploaded, total, failures, batch };

  if (failures.length > 0) {
    batch = await resumeFileIngestBatch(batch.id);
    yield {
      phase: "error",
      uploaded: batch.files.filter((file) => file.status !== "pending").length,
      total,
      batch,
      error: `${failures.length} of ${total} files still need attention`,
      failures,
    };
    return;
  }

  const job = await commitFileIngest(batch.id);
  batch = { ...batch, status: "processing", targets: [] };
  yield { phase: "processing", uploaded: total, total, id: job.id, batch };
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
