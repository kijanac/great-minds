import { mkdir } from "node:fs/promises";
import { posix, resolve } from "node:path";

import type { FileFingerprint, FileIngestUploadTarget, Uuid } from "@great-minds/domain";
import { Cause, Context, Effect, Layer, Schema } from "effect";

import { backgroundLoop } from "./background-loop.ts";
import { ClockService } from "./clock.ts";
import { AppConfig } from "./config.ts";
import { StructuredLogger } from "./logging.ts";
import { readSourceControl } from "./source-identity.ts";
import { HistoryStore, makeHistoryStore } from "./conversation-history/store.ts";
import { openLocalConditionalObjectStore } from "./storage/local-conditional-object-store.ts";
import { makeLocalObjectStore, pruneLocalStaging } from "./storage/local-object-store.ts";
import {
  type ConditionalObjectStore,
  type ObjectStore,
  type ObjectVersionConflict,
  StorageBackendError,
  storageBackendError,
} from "./storage/object-store.ts";
import {
  ensureR2Bucket,
  makeR2ObjectStoreBackend,
  type R2ObjectStoreBackend,
} from "./storage/r2-object-store.ts";

const VAULTS_DIR = "vaults";
const USERS_DIR = "users";
const PROPOSALS_DIR = "proposals";
const STAGING_DIR = "staging";
const LOCAL_STAGED_UPLOAD_EXPIRES_MS = 24 * 60 * 60 * 1000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class StorageFileMissing extends Schema.TaggedError<StorageFileMissing>()(
  "StorageFileMissing",
  {
    path: Schema.String,
  },
) {}

export type StorageOwner = { readonly kind: "vault" | "user"; readonly id: Uuid };

export const vaultOwner = (id: Uuid): StorageOwner => ({ kind: "vault", id });

export const userOwner = (id: Uuid): StorageOwner => ({ kind: "user", id });

export const READ_CONCURRENCY = 16;

type ContentStorageShape = {
  readonly listMarkdown: (
    owner: StorageOwner,
    scope: "raw" | "wiki",
  ) => Effect.Effect<readonly { readonly path: string; readonly etag: string | null }[]>;
  readonly readText: (
    owner: StorageOwner,
    path: string,
  ) => Effect.Effect<string, StorageFileMissing>;
  readonly writeText: (owner: StorageOwner, path: string, content: string) => Effect.Effect<void>;
  readonly readVersionedText: (
    owner: StorageOwner,
    path: string,
  ) => Effect.Effect<{ readonly content: string; readonly version: string }, StorageFileMissing>;
  readonly writeTextIfVersion: (
    owner: StorageOwner,
    path: string,
    expectedVersion: string | null,
    content: string,
  ) => Effect.Effect<void, ObjectVersionConflict>;
  readonly exists: (owner: StorageOwner, path: string) => Effect.Effect<boolean>;
  readonly deletePath: (owner: StorageOwner, path: string) => Effect.Effect<void>;
  readonly clear: (owner: StorageOwner) => Effect.Effect<void>;
};

type StagedStorageShape = {
  readonly readStagedBytes: (
    vaultId: Uuid,
    batchId: Uuid,
    hash: FileFingerprint,
  ) => Effect.Effect<Uint8Array, StorageFileMissing | StorageBackendError>;
  readonly stagedExists: (
    vaultId: Uuid,
    batchId: Uuid,
    hash: FileFingerprint,
  ) => Effect.Effect<boolean, StorageBackendError>;
  readonly deleteStaged: (
    vaultId: Uuid,
    batchId: Uuid,
    hash: FileFingerprint,
  ) => Effect.Effect<void, StorageBackendError>;
  readonly clearStagedBatch: (vaultId: Uuid, batchId: Uuid) => Effect.Effect<void>;
  readonly clearStagedVault: (vaultId: Uuid) => Effect.Effect<void>;
};

type ProposalStorageShape = {
  readonly readText: (path: string) => Effect.Effect<string, StorageFileMissing>;
  readonly writeText: (path: string, content: string) => Effect.Effect<void>;
  readonly deletePath: (path: string) => Effect.Effect<void>;
};

type StagedUploadDescriptor = {
  readonly hash: FileFingerprint;
  readonly contentType: string;
  readonly contentLength: number;
};

type StagedUploadGatewayShape = {
  readonly prepare: (
    vaultId: Uuid,
    batchId: Uuid,
    files: readonly StagedUploadDescriptor[],
  ) => Effect.Effect<readonly FileIngestUploadTarget[], StorageBackendError>;
} & (
  | {
      readonly kind: "api";
      readonly receive: (
        vaultId: Uuid,
        batchId: Uuid,
        hash: FileFingerprint,
        bytes: Uint8Array,
        contentType: string,
      ) => Effect.Effect<void, StorageBackendError>;
    }
  | { readonly kind: "presigned" }
);

export class ContentStorage extends Context.Service<ContentStorage, ContentStorageShape>()(
  "@great-minds/server/ContentStorage",
) {}

export class StagedStorage extends Context.Service<StagedStorage, StagedStorageShape>()(
  "@great-minds/server/StagedStorage",
) {}

export class StagedUploadGateway extends Context.Service<
  StagedUploadGateway,
  StagedUploadGatewayShape
>()("@great-minds/server/StagedUploadGateway") {}

export class ProposalStorage extends Context.Service<ProposalStorage, ProposalStorageShape>()(
  "@great-minds/server/ProposalStorage",
) {}

type LocalStorageBackend = {
  readonly kind: "local";
  readonly directory: string;
  readonly objects: ObjectStore & ConditionalObjectStore;
};

type R2StorageBackend = R2ObjectStoreBackend & { readonly kind: "r2" };

type StorageBackendShape = LocalStorageBackend | R2StorageBackend;

class StorageBackend extends Context.Service<StorageBackend, StorageBackendShape>()(
  "@great-minds/server/StorageBackend",
) {}

const ownerPrefix = (owner: StorageOwner) =>
  `${owner.kind === "vault" ? VAULTS_DIR : USERS_DIR}/${owner.id}/`;

const scopedKey = (prefix: string, path: string) => {
  const normalized = posix.normalize(path);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    posix.isAbsolute(path)
  ) {
    throw new Error(`Path escapes storage scope: ${path}`);
  }
  return `${prefix}${normalized}`;
};

const stagedPrefix = (vaultId: Uuid, batchId: Uuid) => `${STAGING_DIR}/${vaultId}/${batchId}/`;

const stagedKey = (vaultId: Uuid, batchId: Uuid, hash: FileFingerprint) =>
  `${stagedPrefix(vaultId, batchId)}${hash}`;

const fileMissing = (path: string) => new StorageFileMissing({ path });

const contentTypeFor = (path: string) => (path.endsWith(".md") ? "text/markdown" : "text/plain");

const readText = (objects: ObjectStore, prefix: string, path: string) =>
  objects.get(scopedKey(prefix, path)).pipe(
    Effect.catchTag("StorageBackendError", Effect.die),
    Effect.mapError(() => fileMissing(path)),
    Effect.map((bytes) => textDecoder.decode(bytes)),
  );

const writeText = (objects: ObjectStore, prefix: string, path: string, content: string) =>
  objects
    .put(scopedKey(prefix, path), textEncoder.encode(content), {
      contentType: contentTypeFor(path),
    })
    .pipe(Effect.orDie);

const makeStorageBackend = Effect.gen(function* () {
  const config = yield* AppConfig;
  if (config.storageBackend === "r2") {
    return { kind: "r2", ...makeR2ObjectStoreBackend(config) } satisfies R2StorageBackend;
  }
  const directory = resolve(config.dataDir);
  yield* Effect.tryPromise({
    try: () => mkdir(directory, { recursive: true }),
    catch: (error) => storageBackendError("prepare", directory, error),
  }).pipe(Effect.orDie);
  const conditional = yield* openLocalConditionalObjectStore(directory).pipe(Effect.orDie);
  return {
    kind: "local",
    directory,
    objects: { ...makeLocalObjectStore(directory), ...conditional },
  } satisfies LocalStorageBackend;
});

export const StorageBackendLive = Layer.effect(StorageBackend, makeStorageBackend);

export const HistoryStoreLive = Layer.effect(
  HistoryStore,
  Effect.map(StorageBackend, (backend) => makeHistoryStore(backend.objects)),
);

export const ContentStorageLive = Layer.effect(
  ContentStorage,
  Effect.gen(function* () {
    const backend = yield* StorageBackend;
    const logger = yield* StructuredLogger;
    const objects = backend.objects;
    const isSourcePath = (owner: StorageOwner, path: string) =>
      owner.kind === "vault" && posix.normalize(path).startsWith("raw/");
    const readContent = (owner: StorageOwner, path: string) =>
      Effect.gen(function* () {
        const content = yield* readText(objects, ownerPrefix(owner), path);
        if (isSourcePath(owner, path) && readSourceControl(content) !== undefined) {
          return yield* fileMissing(path);
        }
        return content;
      });
    return {
      listMarkdown: (owner, scope) => {
        const prefix = ownerPrefix(owner);
        return objects.list(scopedKey(prefix, `${scope}/`), scope === "raw").pipe(
          Effect.orDie,
          Effect.map((entries) =>
            entries
              .map((entry) => ({
                path: entry.key.slice(prefix.length),
                etag: entry.etag,
              }))
              .filter((entry) => entry.path.endsWith(".md"))
              .sort((left, right) =>
                left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
              ),
          ),
        );
      },
      readText: readContent,
      writeText: (owner, path, content) => writeText(objects, ownerPrefix(owner), path, content),
      readVersionedText: (owner, path) =>
        objects.getVersioned(scopedKey(ownerPrefix(owner), path)).pipe(
          Effect.catchTag("StorageBackendError", Effect.die),
          Effect.mapError(() => fileMissing(path)),
          Effect.map((object) => ({
            content: textDecoder.decode(object.bytes),
            version: object.version,
          })),
        ),
      writeTextIfVersion: (owner, path, expectedVersion, content) =>
        objects
          .putIfVersion(
            scopedKey(ownerPrefix(owner), path),
            expectedVersion,
            textEncoder.encode(content),
            { contentType: contentTypeFor(path) },
          )
          .pipe(Effect.catchTag("StorageBackendError", Effect.die)),
      exists: (owner, path) =>
        isSourcePath(owner, path)
          ? readContent(owner, path).pipe(
              Effect.match({ onSuccess: () => true, onFailure: () => false }),
            )
          : objects.exists(scopedKey(ownerPrefix(owner), path)).pipe(Effect.orDie),
      deletePath: (owner, path) =>
        objects.remove(scopedKey(ownerPrefix(owner), path)).pipe(Effect.orDie),
      clear: (owner) =>
        objects.removePrefix(ownerPrefix(owner)).pipe(
          Effect.catchCause((cause) =>
            logger
              .error(`${backend.kind}_storage.clear_${owner.kind}_failed`, {
                [`${owner.kind}_id`]: owner.id,
                error: "Cause",
                error_message: Cause.pretty(cause),
              })
              .pipe(Effect.andThen(Effect.failCause(cause))),
          ),
          Effect.orDie,
        ),
    } satisfies ContentStorageShape;
  }),
);

export const StagedStorageLive = Layer.effect(
  StagedStorage,
  Effect.map(StorageBackend, (backend) => {
    const objects = backend.objects;
    return {
      readStagedBytes: (vaultId, batchId, hash) => {
        const path = stagedKey(vaultId, batchId, hash);
        return objects
          .get(path)
          .pipe(Effect.catchTag("ObjectMissing", () => Effect.fail(fileMissing(path))));
      },
      stagedExists: (vaultId, batchId, hash) => objects.exists(stagedKey(vaultId, batchId, hash)),
      deleteStaged: (vaultId, batchId, hash) => objects.remove(stagedKey(vaultId, batchId, hash)),
      clearStagedBatch: (vaultId, batchId) =>
        objects.removePrefix(stagedPrefix(vaultId, batchId)).pipe(Effect.orDie),
      clearStagedVault: (vaultId) =>
        objects.removePrefix(`${STAGING_DIR}/${vaultId}/`).pipe(Effect.orDie),
    } satisfies StagedStorageShape;
  }),
);

export const StagedUploadGatewayLive = Layer.effect(
  StagedUploadGateway,
  Effect.map(StorageBackend, (backend): StagedUploadGatewayShape => {
    if (backend.kind === "local") {
      return {
        kind: "api",
        prepare: (_vaultId, _batchId, files) =>
          Effect.succeed(files.map((file) => ({ hash: file.hash, transport: "api" as const }))),
        receive: (vaultId, batchId, hash, bytes, contentType) =>
          backend.objects.put(stagedKey(vaultId, batchId, hash), bytes, { contentType }),
      };
    }
    return {
      kind: "presigned",
      prepare: (vaultId, batchId, files) =>
        Effect.forEach(files, (file) => {
          const path = stagedKey(vaultId, batchId, file.hash);
          return backend.prepareUpload(path, file.contentType, file.contentLength).pipe(
            Effect.map((url) => ({
              hash: file.hash,
              transport: "presigned" as const,
              url,
            })),
          );
        }),
    };
  }),
);

export const StorageMaintenanceLoopLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const backend = yield* StorageBackend;
    if (backend.kind === "r2") return;
    const clock = yield* ClockService;
    yield* backgroundLoop({
      failureEvent: "local_storage.staging_reap_failed",
      interval: "1 hour",
      tick: clock.now.pipe(
        Effect.flatMap((now) =>
          pruneLocalStaging(backend.directory, now.getTime() - LOCAL_STAGED_UPLOAD_EXPIRES_MS),
        ),
      ),
    });
  }),
);

export const ProposalStorageLive = Layer.effect(
  ProposalStorage,
  Effect.map(StorageBackend, (backend) => {
    const prefix = `${PROPOSALS_DIR}/`;
    const objects = backend.objects;
    return {
      readText: (path) => readText(objects, prefix, path),
      writeText: (path, content) => writeText(objects, prefix, path, content),
      deletePath: (path) => objects.remove(scopedKey(prefix, path)).pipe(Effect.orDie),
    } satisfies ProposalStorageShape;
  }),
);

export const ensureStorageReady = (config: AppConfig["Service"]) =>
  config.storageBackend === "r2"
    ? ensureR2Bucket(config)
    : pruneLocalStaging(config.dataDir, Date.now() - LOCAL_STAGED_UPLOAD_EXPIRES_MS).pipe(
        Effect.orDie,
      );
