import {
  type FileFingerprint,
  type FileIngestBatch,
  type Uuid,
  type UserSuggestionResult,
} from "@great-minds/domain";
import { Effect } from "effect";
import { errorMessage, fingerprint, manifestOf, newUuid, uploadTarget } from "@great-minds/client";

import { api, connection, run } from "./app";
import { selectedVault } from "./selected-vault";

export type { FileIngestBatch, UserSuggestionResult };

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
  id?: Uuid;
  batch?: FileIngestBatch;
  error?: string;
  failures?: UploadFailure[];
}

export const hashFile = (file: File): Promise<FileFingerprint> => fingerprint(file);

export function checkDupes(
  clientHashes: readonly FileFingerprint[],
): Promise<Set<FileFingerprint>> {
  if (clientHashes.length === 0) return Promise.resolve(new Set());
  return run(
    api.ingest
      .checkFileIngestDupes({
        params: { vault_id: selectedVault() },
        payload: { client_hashes: clientHashes },
      })
      .pipe(
        Effect.map((response) => new Set(response.existing)),
        Effect.catch(() => Effect.succeed(new Set<FileFingerprint>())),
      ),
  );
}

export interface HashedFile {
  file: File;
  hash: FileFingerprint;
}

export const hashFiles = (files: readonly File[]): Promise<readonly HashedFile[]> =>
  run(
    Effect.forEach(
      files,
      (file) => Effect.promise(async () => ({ file, hash: await hashFile(file) })),
      { concurrency: PUT_CONCURRENCY },
    ),
  );

const uploadFileOf = ({ file, hash }: HashedFile) => ({
  name: file.name,
  content: file,
  hash,
  mimetype: file.type,
});

export function createFileIngestBatch(
  hashedFiles: readonly HashedFile[],
  batchId: Uuid = newUuid(),
): Promise<FileIngestBatch> {
  return run(
    api.ingest.createFileIngest({
      params: { vault_id: selectedVault() },
      payload: { batch_id: batchId, files: manifestOf(hashedFiles.map(uploadFileOf)) },
    }),
  );
}

export function getFileIngestBatch(batchId: Uuid): Promise<FileIngestBatch | null> {
  return run(
    api.ingest
      .getFileIngest({ params: { batch_id: batchId } })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null))),
  );
}

export function resumeFileIngestBatch(batchId: Uuid): Promise<FileIngestBatch> {
  return run(api.ingest.resumeFileIngest({ params: { batch_id: batchId } }));
}

type UploadResult = { ok: true; hash: FileFingerprint } | { ok: false; failure: UploadFailure };

const uploadOne =
  (batch: FileIngestBatch, fileByHash: ReadonlyMap<FileFingerprint, File>) =>
  (target: FileIngestBatch["targets"][number]) => {
    const manifestFile = batch.files.find((file) => file.hash === target.hash);
    const file = fileByHash.get(target.hash);
    if (!manifestFile || !file) {
      return Effect.succeed<UploadResult>({
        ok: false,
        failure: {
          name: manifestFile?.name ?? target.hash,
          error: "Reselect this file to continue",
        },
      });
    }
    return uploadTarget(connection, batch, target, uploadFileOf({ file, hash: target.hash })).pipe(
      Effect.as<UploadResult>({ ok: true, hash: target.hash }),
      Effect.catch((error) =>
        Effect.succeed<UploadResult>({
          ok: false,
          failure: { name: manifestFile.name, error: errorMessage(error, "Upload failed") },
        }),
      ),
    );
  };

export async function* continueFileIngest(
  initialBatch: FileIngestBatch,
  hashedFiles: readonly HashedFile[],
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
  const results = await run(
    Effect.forEach(batch.targets, uploadOne(batch, fileByHash), {
      concurrency: PUT_CONCURRENCY,
    }),
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

  const job = await run(api.ingest.commitFileIngest({ params: { batch_id: batch.id } }));
  batch = { ...batch, status: "processing", targets: [] };
  yield { phase: "processing", uploaded: total, total, id: job.id, batch };
}

export function postUserSuggestion(params: {
  body: string;
  anchoredTo: string;
  anchoredSection: string;
}): Promise<UserSuggestionResult> {
  return run(
    api.ingest.ingestUserSuggestion({
      params: { vault_id: selectedVault() },
      payload: {
        body: params.body,
        anchored_to: params.anchoredTo,
        anchored_section: params.anchoredSection,
      },
    }),
  );
}
