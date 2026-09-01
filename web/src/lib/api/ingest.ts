import {
  FileFingerprint,
  Uuid,
  type FileIngestBatch,
  type UserSuggestionIntent,
  type UserSuggestionResult,
} from "@great-minds/domain";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";

import { getVaultId } from "../vault-selection";

import { api, http, run } from "./app";
import { errorMessage } from "./errors";

export type { FileIngestBatch, UserSuggestionIntent, UserSuggestionResult };

const uuid = Schema.decodeSync(Uuid);
const fingerprint = Schema.decodeSync(FileFingerprint);
const PUT_CONCURRENCY = 4;

function selectedVault(): Uuid {
  const id = getVaultId();
  if (id === null) throw new Error("No vault selected");
  return uuid(id);
}

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

export async function hashFile(file: File): Promise<string> {
  return sha256Hex(await file.arrayBuffer());
}

export function checkDupes(clientHashes: string[]): Promise<Set<string>> {
  if (clientHashes.length === 0) return Promise.resolve(new Set());
  return run(
    api.ingest
      .checkFileIngestDupes({
        params: { vault_id: selectedVault() },
        payload: { client_hashes: clientHashes.map((hash) => fingerprint(hash)) },
      })
      .pipe(
        Effect.map((response) => new Set<string>(response.existing)),
        Effect.catch(() => Effect.succeed(new Set<string>())),
      ),
  );
}

async function pMap<T, R>(
  items: readonly T[],
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

export interface HashedFile {
  file: File;
  hash: string;
}

export const hashFiles = (files: File[]): Promise<HashedFile[]> =>
  pMap(files, async (file) => ({ file, hash: await hashFile(file) }), PUT_CONCURRENCY);

const manifestFor = (hashedFiles: HashedFile[]) =>
  hashedFiles.map(({ file, hash }) => ({
    name: file.name,
    size: file.size,
    hash: fingerprint(hash),
    mimetype: file.type,
  }));

export function createFileIngestBatch(
  hashedFiles: HashedFile[],
  batchId: string = crypto.randomUUID(),
): Promise<FileIngestBatch> {
  return run(
    api.ingest.createFileIngest({
      params: { vault_id: selectedVault() },
      payload: { batch_id: uuid(batchId), files: manifestFor(hashedFiles) },
    }),
  );
}

export function getFileIngestBatch(batchId: string): Promise<FileIngestBatch | null> {
  return run(
    api.ingest
      .getFileIngest({ params: { batch_id: uuid(batchId) } })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null))),
  );
}

export function resumeFileIngestBatch(batchId: string): Promise<FileIngestBatch> {
  return run(api.ingest.resumeFileIngest({ params: { batch_id: uuid(batchId) } }));
}

const uploadViaApi = (batchId: Uuid, file: File, hash: FileFingerprint) => {
  const formData = new FormData();
  formData.append("file", file);
  return run(
    http.execute(
      HttpClientRequest.post(`/file-ingests/${batchId}/files/${hash}`).pipe(
        HttpClientRequest.bodyFormData(formData),
      ),
    ),
  );
};

const uploadViaPresignedUrl = (url: string, file: File) =>
  fetch(url, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });

const acknowledgeUpload = (batchId: Uuid, hash: FileFingerprint) =>
  run(api.ingest.acknowledgeFileIngestUpload({ params: { batch_id: batchId, hash } }));

const commitFileIngest = (batchId: Uuid) =>
  run(api.ingest.commitFileIngest({ params: { batch_id: batchId } }));

const isSuccessStatus = (status: number) => status >= 200 && status < 300;

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
        const status =
          target.transport === "presigned"
            ? (await uploadViaPresignedUrl(target.url, file)).status
            : (await uploadViaApi(batch.id, file, target.hash)).status;
        if (!isSuccessStatus(status)) {
          return {
            ok: false,
            failure: { name: manifestFile.name, error: `Upload returned ${status}` },
          };
        }
        await acknowledgeUpload(batch.id, target.hash);
        return { ok: true, hash: target.hash };
      } catch (error) {
        return {
          ok: false,
          failure: { name: manifestFile.name, error: errorMessage(error, "Upload failed") },
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

export function postUserSuggestion(params: {
  body: string;
  intent: UserSuggestionIntent;
  anchoredTo: string;
  anchoredSection: string;
}): Promise<UserSuggestionResult> {
  return run(
    api.ingest.ingestUserSuggestion({
      params: { vault_id: selectedVault() },
      payload: {
        body: params.body,
        intent: params.intent,
        anchored_to: params.anchoredTo,
        anchored_section: params.anchoredSection,
      },
    }),
  );
}
