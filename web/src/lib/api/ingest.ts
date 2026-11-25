import {
  type FileFingerprint,
  type FileIngestBatch,
  type FileIngestBatchCreate,
  type Uuid,
  type UserSuggestionResult,
} from "@great-minds/domain";
import { Effect } from "effect";
import { errorMessage, fingerprint, manifestOf, uploadTarget } from "@great-minds/client";

import { api, connection, run } from "./app";
import { selectedVault } from "./selected-vault";

export type { FileIngestBatch, UserSuggestionResult };

const PUT_CONCURRENCY = 4;

export const hashFile = (file: File): Promise<FileFingerprint> => fingerprint(file);

export function checkDupes(
  vaultId: Uuid,
  clientHashes: readonly FileFingerprint[],
): Promise<Set<FileFingerprint>> {
  if (clientHashes.length === 0) return Promise.resolve(new Set());
  return run(
    api.ingest
      .checkFileIngestDupes({
        params: { vault_id: vaultId },
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

export const fileIngestManifest = (files: readonly HashedFile[]): FileIngestBatchCreate["files"] =>
  manifestOf(
    files.map(({ file, hash }) => ({ name: file.name, content: file, hash, mimetype: file.type })),
  );

export function createFileIngestBatch(vaultId: Uuid, payload: FileIngestBatchCreate) {
  return run(api.ingest.createFileIngest({ params: { vault_id: vaultId }, payload }));
}

export function getFileIngestBatch(batchId: Uuid, signal?: AbortSignal) {
  return run(
    api.ingest
      .getFileIngest({ params: { batch_id: batchId } })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null))),
    { signal },
  );
}

export function resumeFileIngestBatch(batchId: Uuid, signal?: AbortSignal) {
  return run(api.ingest.resumeFileIngest({ params: { batch_id: batchId } }), { signal });
}

export function commitFileIngestBatch(batchId: Uuid) {
  return run(api.ingest.commitFileIngest({ params: { batch_id: batchId } }));
}

export function sendFileIngestFiles(batch: FileIngestBatch, files: readonly HashedFile[]) {
  const byHash = new Map(files.map(({ file, hash }) => [hash, file]));
  const pending = new Map(
    batch.files.filter((file) => file.status === "pending").map((file) => [file.hash, file]),
  );
  const transfers = batch.targets.flatMap((target) => {
    const file = byHash.get(target.hash);
    const manifest = pending.get(target.hash);
    if (!file || !manifest) return [];
    const { hash, name, mimetype } = manifest;
    return uploadTarget(connection, batch, target, { name, content: file, hash, mimetype }).pipe(
      Effect.as({ hash, error: null }),
      Effect.catch((error) =>
        Effect.succeed({ hash, error: errorMessage(error, "Upload failed") }),
      ),
    );
  });
  return run(Effect.all(transfers, { concurrency: PUT_CONCURRENCY }));
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
