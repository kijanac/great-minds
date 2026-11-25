import { FileIngestBatchCreate, Uuid } from "@great-minds/domain";
import { newUuid } from "@great-minds/client";
import { Option, Schema } from "effect";

import { auth } from "#lib/auth.svelte.ts";

const UploadDraft = Schema.Struct({
  vaultId: Uuid,
  batchId: FileIngestBatchCreate.fields.batch_id,
  manifest: FileIngestBatchCreate.fields.files,
});
export type UploadDraft = typeof UploadDraft.Type;

const decodeDrafts = Schema.decodeOption(Schema.fromJsonString(Schema.Array(UploadDraft)));
const sameManifest = Schema.toEquivalence(UploadDraft.fields.manifest);
const storageKey = (userId: string) => `file-ingest-drafts:${userId}`;
let revision = $state(0);

function readDrafts(userId: string): readonly UploadDraft[] {
  void revision;
  try {
    return Option.getOrElse(
      decodeDrafts(sessionStorage.getItem(storageKey(userId)) ?? "[]"),
      () => [],
    );
  } catch {
    return [];
  }
}

export function fileIngestDrafts(): readonly UploadDraft[] {
  return auth.userId ? readDrafts(auth.userId) : [];
}

function writeDrafts(userId: string, drafts: readonly UploadDraft[]) {
  if (drafts.length === 0) sessionStorage.removeItem(storageKey(userId));
  else sessionStorage.setItem(storageKey(userId), JSON.stringify(drafts));
  revision += 1;
}

export function rememberUpload(userId: string, vaultId: Uuid, manifest: UploadDraft["manifest"]) {
  const drafts = readDrafts(userId);
  const existing = drafts.find(
    (draft) => draft.vaultId === vaultId && sameManifest(draft.manifest, manifest),
  );
  if (existing) return existing;
  const draft = { vaultId, batchId: newUuid(), manifest };
  writeDrafts(userId, [...drafts, draft]);
  return draft;
}

export function forgetUpload(userId: string, batchId: Uuid) {
  const drafts = readDrafts(userId);
  const remaining = drafts.filter((draft) => draft.batchId !== batchId);
  if (remaining.length !== drafts.length) writeDrafts(userId, remaining);
}
