import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { FileFingerprint, Uuid } from "@great-minds/domain";
import { Cause, Context, Effect, Layer, Option, Redacted, Schema } from "effect";

import { AppConfig } from "./config.ts";
import { errorDetails } from "./error-details.ts";
import { StructuredLogger } from "./logging.ts";

const VAULTS_DIR = "vaults";
const USERS_DIR = "users";
const PROPOSALS_DIR = "proposals";
const STAGING_DIR = "staging";
const R2_READ_TIMEOUT = "30 seconds";
const R2_WRITE_TIMEOUT = "120 seconds";
const R2_ADMIN_TIMEOUT = "120 seconds";
const R2_STAGED_UPLOAD_EXPIRES_SECONDS = 3600;
const LOCAL_STAGED_UPLOAD_EXPIRES_MS = 24 * 60 * 60 * 1000;

export class StorageFileMissing extends Schema.TaggedErrorClass<StorageFileMissing>()(
  "StorageFileMissing",
  {
    path: Schema.String,
  },
) {}

export class StagedStorageError extends Schema.TaggedErrorClass<StagedStorageError>()(
  "StagedStorageError",
  {
    operation: Schema.Literals(["prepare", "write", "read", "delete"]),
    path: Schema.String,
    errorType: Schema.String,
    message: Schema.String,
  },
) {}

export type StorageOwner = { readonly kind: "vault" | "user"; readonly id: Uuid };

export const vaultOwner = (id: Uuid): StorageOwner => ({ kind: "vault", id });

export const userOwner = (id: Uuid): StorageOwner => ({ kind: "user", id });

type ContentStorageShape = {
  readonly listMarkdown: (
    owner: StorageOwner,
    scope: "raw" | "wiki",
  ) => Effect.Effect<readonly { readonly path: string; readonly etag: string | null }[]>;
  readonly readText: (owner: StorageOwner, path: string) => Effect.Effect<string, StorageFileMissing>;
  readonly writeText: (owner: StorageOwner, path: string, content: string) => Effect.Effect<void>;
  readonly appendText: (owner: StorageOwner, path: string, content: string) => Effect.Effect<void>;
  readonly exists: (owner: StorageOwner, path: string) => Effect.Effect<boolean>;
  readonly deletePath: (owner: StorageOwner, path: string) => Effect.Effect<void>;
  readonly clear: (owner: StorageOwner) => Effect.Effect<void>;
};

export type StagedPutTarget =
  | { readonly transport: "api" }
  | { readonly transport: "presigned"; readonly url: string };

type StagedStorageShape = {
  readonly pruneExpiredStaged: () => Effect.Effect<void, StagedStorageError>;
  readonly prepareStagedPut: (
    vaultId: Uuid,
    hash: FileFingerprint,
    contentType: string,
    contentLength: number,
  ) => Effect.Effect<StagedPutTarget, StagedStorageError>;
  readonly writeStagedBytes: (
    vaultId: Uuid,
    hash: FileFingerprint,
    bytes: Uint8Array,
    contentType: string,
  ) => Effect.Effect<void, StagedStorageError>;
  readonly readStagedBytes: (
    vaultId: Uuid,
    hash: FileFingerprint,
  ) => Effect.Effect<Uint8Array, StorageFileMissing | StagedStorageError>;
  readonly deleteStaged: (
    vaultId: Uuid,
    hash: FileFingerprint,
  ) => Effect.Effect<void, StagedStorageError>;
  readonly clearStaged: (vaultId: Uuid) => Effect.Effect<void>;
};

export class ContentStorage extends Context.Service<ContentStorage, ContentStorageShape>()(
  "@great-minds/server/ContentStorage",
) {}

export class StagedStorage extends Context.Service<StagedStorage, StagedStorageShape>()(
  "@great-minds/server/StagedStorage",
) {}

type StorageEntry = { readonly path: string; readonly etag: string | null };

type LocalDriverRoot = { readonly kind: "local"; readonly directory: string };

type R2DriverRoot = {
  readonly kind: "r2";
  readonly bucket: string;
  readonly keyPrefix: string;
};

type DriverRoot = LocalDriverRoot | R2DriverRoot;

type StorageDriver<Root extends DriverRoot> = {
  readonly getText: (root: Root, path: string) => Effect.Effect<string, StorageFileMissing>;
  readonly putText: (root: Root, path: string, content: string) => Effect.Effect<void>;
  readonly appendText: (root: Root, path: string, content: string) => Effect.Effect<void>;
  readonly remove: (root: Root, path: string) => Effect.Effect<void>;
  readonly removeAll: (root: Root) => Effect.Effect<void>;
  readonly list: (root: Root, subdir: string, recursive: boolean) => Effect.Effect<readonly StorageEntry[]>;
  readonly exists: (root: Root, path: string) => Effect.Effect<boolean>;
};

type ProposalStorageShape = {
  readonly readText: (path: string) => Effect.Effect<string, StorageFileMissing>;
  readonly writeText: (path: string, content: string) => Effect.Effect<void>;
  readonly deletePath: (path: string) => Effect.Effect<void>;
};

export class ProposalStorage extends Context.Service<ProposalStorage, ProposalStorageShape>()(
  "@great-minds/server/ProposalStorage",
) {}

const isWithinRoot = (root: string, child: string) => {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const fileMissing = (path: string) => new StorageFileMissing({ path });

const isNodeMissing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const resolveChild = (root: string, path: string) => {
  const fullPath = resolve(root, path);
  if (!isWithinRoot(root, fullPath)) {
    throw new Error(`Path escapes storage root: ${path}`);
  }
  return fullPath;
};

const readLocalText = (root: string, path: string) =>
  Effect.gen(function* () {
    const fullPath = resolveChild(root, path);
    const result = yield* Effect.result(
      Effect.tryPromise({
        try: () => readFile(fullPath, "utf8"),
        catch: (error) => error,
      }),
    );
    if (result._tag === "Success") {
      return result.success;
    }
    if (isNodeMissing(result.failure)) {
      return yield* fileMissing(path);
    }
    throw result.failure;
  });

const writeLocalText = (root: string, path: string, content: string) =>
  Effect.gen(function* () {
    const fullPath = resolveChild(root, path);
    yield* Effect.tryPromise(() => mkdir(resolve(fullPath, ".."), { recursive: true })).pipe(
      Effect.orDie,
    );
    yield* Effect.tryPromise(() => writeFile(fullPath, content, "utf8")).pipe(Effect.orDie);
  });

const appendLocalText = (root: string, path: string, content: string) =>
  Effect.gen(function* () {
    const fullPath = resolveChild(root, path);
    yield* Effect.tryPromise(() => mkdir(resolve(fullPath, ".."), { recursive: true })).pipe(
      Effect.orDie,
    );
    yield* Effect.tryPromise(() => appendFile(fullPath, content, "utf8")).pipe(Effect.orDie);
  });

const localExists = (root: string, path: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(readLocalText(root, path));
    return result._tag === "Success";
  });

const deleteLocalPath = (root: string, path: string) =>
  Effect.gen(function* () {
    const fullPath = resolveChild(root, path);
    const result = yield* Effect.result(
      Effect.tryPromise({
        try: () => unlink(fullPath),
        catch: (error) => error,
      }),
    );
    if (result._tag === "Failure" && !isNodeMissing(result.failure)) {
      throw result.failure;
    }
  });

const makeContentStorage = <Root extends DriverRoot>(
  backend: "local" | "r2",
  resolveRoot: (owner: StorageOwner) => Effect.Effect<Root>,
  driver: StorageDriver<Root>,
  logger: StructuredLogger["Service"],
): ContentStorageShape => ({
  listMarkdown: (owner, scope) =>
    Effect.gen(function* () {
      const root = yield* resolveRoot(owner);
      const entries = yield* driver.list(root, `${scope}/`, scope === "raw");
      return entries
        .filter((entry) => entry.path.endsWith(".md"))
        .sort((left, right) =>
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
        );
    }),
  readText: (owner, path) =>
    Effect.gen(function* () {
      const root = yield* resolveRoot(owner);
      return yield* driver.getText(root, path);
    }),
  writeText: (owner, path, content) =>
    Effect.gen(function* () {
      const root = yield* resolveRoot(owner);
      yield* driver.putText(root, path, content);
    }),
  appendText: (owner, path, content) =>
    Effect.gen(function* () {
      const root = yield* resolveRoot(owner);
      yield* driver.appendText(root, path, content);
    }),
  exists: (owner, path) =>
    Effect.gen(function* () {
      const root = yield* resolveRoot(owner);
      return yield* driver.exists(root, path);
    }),
  deletePath: (owner, path) =>
    Effect.gen(function* () {
      const root = yield* resolveRoot(owner);
      yield* driver.remove(root, path);
    }),
  clear: (owner) => {
    let resolvedRoot: Root | undefined;
    return Effect.gen(function* () {
      resolvedRoot = yield* resolveRoot(owner);
      yield* driver.removeAll(resolvedRoot);
    }).pipe(
      Effect.catchCause((cause) =>
        logger
          .error(`${backend}_storage.clear_${owner.kind}_failed`, {
            [`${owner.kind}_id`]: owner.id,
            ...(resolvedRoot?.kind === "r2" ? { bucket: resolvedRoot.bucket } : {}),
            error: "Cause",
            error_message: Cause.pretty(cause),
          })
          .pipe(Effect.andThen(Effect.failCause(cause))),
      ),
      Effect.orDie,
    );
  },
});

const localDriver: StorageDriver<LocalDriverRoot> = {
  getText: (root, path) => readLocalText(root.directory, path),
  putText: (root, path, content) => writeLocalText(root.directory, path, content),
  appendText: (root, path, content) => appendLocalText(root.directory, path, content),
  remove: (root, path) => deleteLocalPath(root.directory, path),
  removeAll: (root) =>
    Effect.tryPromise({
      try: () => rm(root.directory, { recursive: true, force: true }),
      catch: (error) => error,
    }).pipe(Effect.orDie),
  list: (root, subdir, recursive) =>
    Effect.gen(function* () {
      const entries = yield* Effect.result(
        Effect.tryPromise({
          try: () => readdir(resolve(root.directory, subdir), { recursive }),
          catch: (error) => error,
        }),
      );
      if (entries._tag === "Failure") {
        if (isNodeMissing(entries.failure)) return [];
        throw entries.failure;
      }
      return entries.success.map((entry) => ({ path: `${subdir}${entry}`, etag: null }));
    }),
  exists: (root, path) => localExists(root.directory, path),
};

export const LocalContentStorageLive = Layer.effect(
  ContentStorage,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const logger = yield* StructuredLogger;
    const dataRoot = resolve(config.dataDir);
    const resolveRoot = (owner: StorageOwner) =>
      Effect.succeed({
        kind: "local" as const,
        directory: resolve(
          dataRoot,
          owner.kind === "vault" ? VAULTS_DIR : USERS_DIR,
          owner.id,
        ),
      });
    return makeContentStorage("local", resolveRoot, localDriver, logger);
  }),
);

const localStagedError = (
  operation: "prepare" | "write" | "read" | "delete",
  path: string,
  error: unknown,
) =>
  new StagedStorageError({
    operation,
    path,
    errorType: errorName(error),
    message: errorMessage(error),
  });

export const LocalStagedStorageLive = Layer.effect(
  StagedStorage,
  Effect.map(AppConfig, (config) => {
    const root = resolve(config.dataDir, STAGING_DIR);
    const stagedPath = (vaultId: Uuid, hash: FileFingerprint) => `${vaultId}/${hash}`;
    return {
      pruneExpiredStaged: () =>
        Effect.tryPromise({
          try: async () => {
            const entries = await readdir(root, { recursive: true }).catch((error: unknown) => {
              if (isNodeMissing(error)) return [];
              throw error;
            });
            const expiresBefore = Date.now() - LOCAL_STAGED_UPLOAD_EXPIRES_MS;
            await Promise.all(
              entries.map(async (entry) => {
                const path = resolveChild(root, entry);
                const details = await stat(path);
                if (details.isFile() && details.mtimeMs < expiresBefore) {
                  await unlink(path);
                }
              }),
            );
          },
          catch: (error) => error,
        }).pipe(
          Effect.mapError((error) => localStagedError("prepare", STAGING_DIR, error)),
        ),
      prepareStagedPut: () => Effect.succeed({ transport: "api" as const }),
      writeStagedBytes: (vaultId, hash, bytes) => {
        const path = stagedPath(vaultId, hash);
        const fullPath = resolveChild(root, path);
        return Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => mkdir(resolve(fullPath, ".."), { recursive: true }),
            catch: (error) => error,
          }).pipe(
            Effect.mapError((error) => localStagedError("write", path, error)),
          );
          yield* Effect.tryPromise({
            try: () => writeFile(fullPath, bytes),
            catch: (error) => error,
          }).pipe(
            Effect.mapError((error) => localStagedError("write", path, error)),
          );
        });
      },
      readStagedBytes: (vaultId, hash) => {
        const path = stagedPath(vaultId, hash);
        const fullPath = resolveChild(root, path);
        return Effect.tryPromise({
          try: () => readFile(fullPath),
          catch: (error) => error,
        }).pipe(
          Effect.mapError((error) =>
            isNodeMissing(error) ? fileMissing(path) : localStagedError("read", path, error),
          ),
        );
      },
      deleteStaged: (vaultId, hash) => {
        const path = stagedPath(vaultId, hash);
        const fullPath = resolveChild(root, path);
        return Effect.tryPromise({
          try: () => unlink(fullPath),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            isNodeMissing(error)
              ? Effect.void
              : Effect.fail(localStagedError("delete", path, error)),
          ),
        );
      },
      clearStaged: (vaultId) =>
        Effect.tryPromise({
          try: () => rm(resolveChild(root, vaultId), { recursive: true, force: true }),
          catch: (error) => error,
        }).pipe(Effect.orDie),
    } satisfies StagedStorageShape;
  }),
);

export const LocalProposalStorageLive = Layer.effect(
  ProposalStorage,
  Effect.map(AppConfig, (config) => {
    const root = resolve(config.dataDir, PROPOSALS_DIR);
    return {
      readText: (path) => readLocalText(root, path),
      writeText: (path, content) => writeLocalText(root, path, content),
      deletePath: (path) => deleteLocalPath(root, path),
    } satisfies ProposalStorageShape;
  }),
);

const redactedOption = (value: Option.Option<Redacted.Redacted<string>>, label: string) =>
  Option.match(value, {
    onNone: () => {
      throw new Error(`R2 storage missing ${label}`);
    },
    onSome: (redacted) => Redacted.value(redacted),
  });

const stringOption = (value: Option.Option<string>, label: string) =>
  Option.match(value, {
    onNone: () => {
      throw new Error(`R2 storage missing ${label}`);
    },
    onSome: (raw) => raw,
  });

const isR2Missing = (error: unknown) => {
  if (error instanceof NoSuchKey) {
    return true;
  }
  if (error instanceof S3ServiceException) {
    return error.$metadata.httpStatusCode === 404;
  }
  return false;
};

const isR2AlreadyOwned = (error: unknown) =>
  error instanceof S3ServiceException && error.name === "BucketAlreadyOwnedByYou";

const errorName = (error: unknown) => errorDetails(error).errorType;

const errorMessage = (error: unknown) => errorDetails(error).message;

const stagedStorageError = (
  operation: "prepare" | "write" | "read" | "delete",
  path: string,
  error: unknown,
) =>
  new StagedStorageError({
    operation,
    path,
    errorType: errorName(error),
    message: errorMessage(error),
  });

const sharedBucketName = (config: AppConfig["Service"]) =>
  stringOption(config.r2BucketName, "R2_BUCKET_NAME");

const makeR2Client = (config: AppConfig["Service"]) => {
  const accountId = stringOption(config.r2AccountId, "R2_ACCOUNT_ID");
  const accessKeyId = redactedOption(config.r2AccessKeyId, "R2_ACCESS_KEY_ID");
  const secretAccessKey = redactedOption(config.r2SecretAccessKey, "R2_SECRET_ACCESS_KEY");
  return new S3Client({
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    region: "auto",
    credentials: { accessKeyId, secretAccessKey },
  });
};

const r2Key = (root: R2DriverRoot, path: string) => `${root.keyPrefix}${path}`;

const deleteR2Objects = (client: S3Client, bucket: string, prefix?: string) =>
  Effect.gen(function* () {
    let continuationToken: string | undefined;
    do {
      const page = yield* Effect.tryPromise({
        try: (signal) =>
          client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: prefix,
              ContinuationToken: continuationToken,
            }),
            { abortSignal: signal },
          ),
        catch: (error) => error,
      }).pipe(Effect.timeout(R2_WRITE_TIMEOUT));
      const objects = (page.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => key !== undefined)
        .map((Key) => ({ Key }));
      if (objects.length > 0) {
        yield* Effect.tryPromise({
          try: (signal) =>
            client.send(
              new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: objects, Quiet: true },
              }),
              { abortSignal: signal },
            ),
          catch: (error) => error,
        }).pipe(Effect.timeout(R2_WRITE_TIMEOUT));
      }
      continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
  });

const makeR2Driver = (client: S3Client): StorageDriver<R2DriverRoot> => {
  const getText = (root: R2DriverRoot, path: string) =>
    Effect.gen(function* () {
      const key = r2Key(root, path);
      const responseResult = yield* Effect.result(
        Effect.tryPromise({
          try: (signal) =>
            client.send(
              new GetObjectCommand({ Bucket: root.bucket, Key: key }),
              { abortSignal: signal },
            ),
          catch: (error) => error,
        }).pipe(Effect.timeout(R2_READ_TIMEOUT)),
      );
      if (responseResult._tag === "Failure") {
        if (isR2Missing(responseResult.failure)) {
          return yield* fileMissing(path);
        }
        throw responseResult.failure;
      }
      const response = responseResult.success;
      if (response.Body === undefined) {
        throw new Error(`R2 object ${key} returned no body`);
      }
      return yield* Effect.tryPromise(() => response.Body!.transformToString("utf-8")).pipe(
        Effect.timeout(R2_READ_TIMEOUT),
        Effect.orDie,
      );
    });

  const putText = (root: R2DriverRoot, path: string, content: string) =>
    Effect.tryPromise((signal) =>
      client.send(
        new PutObjectCommand({
          Bucket: root.bucket,
          Key: r2Key(root, path),
          Body: content,
          ContentType: path.endsWith(".md") ? "text/markdown" : "text/plain",
        }),
        { abortSignal: signal },
      ),
    ).pipe(Effect.timeout(R2_WRITE_TIMEOUT), Effect.orDie);

  return {
    getText,
    putText,
    appendText: (root, path, content) =>
      Effect.gen(function* () {
        const existing = yield* Effect.result(getText(root, path));
        const prefix = existing._tag === "Success" ? existing.success : "";
        yield* putText(root, path, `${prefix}${content}`);
      }),
    remove: (root, path) =>
      Effect.tryPromise((signal) =>
        client.send(
          new DeleteObjectCommand({ Bucket: root.bucket, Key: r2Key(root, path) }),
          { abortSignal: signal },
        ),
      ).pipe(Effect.timeout(R2_WRITE_TIMEOUT), Effect.orDie),
    removeAll: (root) => deleteR2Objects(client, root.bucket, root.keyPrefix).pipe(Effect.orDie),
    list: (root, subdir, recursive) =>
      Effect.gen(function* () {
        const prefix = r2Key(root, subdir);
        const files: StorageEntry[] = [];
        let continuationToken: string | undefined;
        do {
          const page = yield* Effect.tryPromise((signal) =>
            client.send(
              new ListObjectsV2Command({
                Bucket: root.bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken,
                ...(recursive ? {} : { Delimiter: "/" }),
              }),
              { abortSignal: signal },
            ),
          ).pipe(Effect.timeout(R2_ADMIN_TIMEOUT), Effect.orDie);
          for (const object of page.Contents ?? []) {
            if (object.Key === undefined) continue;
            files.push({
              path: object.Key.slice(root.keyPrefix.length),
              etag: object.ETag?.replaceAll('"', "") ?? null,
            });
          }
          continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
        } while (continuationToken !== undefined);
        return files;
      }),
    exists: (root, path) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          Effect.tryPromise({
            try: (signal) =>
              client.send(
                new HeadObjectCommand({ Bucket: root.bucket, Key: r2Key(root, path) }),
                { abortSignal: signal },
              ),
            catch: (error) => error,
          }).pipe(Effect.timeout(R2_READ_TIMEOUT)),
        );
        if (result._tag === "Success") return true;
        if (isR2Missing(result.failure)) return false;
        throw result.failure;
      }),
  };
};

export const R2ContentStorageLive = Layer.effect(
  ContentStorage,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const logger = yield* StructuredLogger;
    const driver = makeR2Driver(makeR2Client(config));
    const bucket = sharedBucketName(config);

    const resolveRoot = (owner: StorageOwner) =>
      Effect.succeed({
        kind: "r2" as const,
        bucket,
        keyPrefix: `${owner.kind === "vault" ? VAULTS_DIR : USERS_DIR}/${owner.id}/`,
      });

    return makeContentStorage("r2", resolveRoot, driver, logger);
  }),
);

// One-time shared-bucket provisioning, run from the server entrypoint at boot.
export const ensureSharedBucket = (config: AppConfig["Service"]) =>
  Effect.gen(function* () {
    if (config.storageBackend !== "r2") {
      return;
    }
    const client = makeR2Client(config);
    const bucket = sharedBucketName(config);
    const head = yield* Effect.result(
      Effect.tryPromise({
        try: (signal) =>
          client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal }),
        catch: (error) => error,
      }).pipe(Effect.timeout(R2_ADMIN_TIMEOUT)),
    );
    if (head._tag === "Failure") {
      if (!isR2Missing(head.failure)) {
        return yield* Effect.die(head.failure);
      }
      const created = yield* Effect.result(
        Effect.tryPromise({
          try: (signal) =>
            client.send(new CreateBucketCommand({ Bucket: bucket }), { abortSignal: signal }),
          catch: (error) => error,
        }).pipe(Effect.timeout(R2_ADMIN_TIMEOUT)),
      );
      if (created._tag === "Failure" && !isR2AlreadyOwned(created.failure)) {
        return yield* Effect.die(created.failure);
      }
    }
    if (config.corsOrigins.length > 0) {
      yield* Effect.tryPromise((signal) =>
        client.send(
          new PutBucketCorsCommand({
            Bucket: bucket,
            CORSConfiguration: {
              CORSRules: [
                {
                  AllowedMethods: ["PUT"],
                  AllowedOrigins: [...config.corsOrigins],
                  AllowedHeaders: ["Content-Type", "Content-Length"],
                  ExposeHeaders: ["ETag"],
                  MaxAgeSeconds: 3600,
                },
              ],
            },
          }),
          { abortSignal: signal },
        ),
      ).pipe(Effect.timeout(R2_ADMIN_TIMEOUT), Effect.orDie);
    }
    yield* Effect.tryPromise((signal) =>
      client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: "expire-staging",
                Status: "Enabled",
                Filter: { Prefix: "staging/" },
                Expiration: { Days: 1 },
              },
            ],
          },
        }),
        { abortSignal: signal },
      ),
    ).pipe(Effect.timeout(R2_ADMIN_TIMEOUT), Effect.orDie);
  });

export const R2StagedStorageLive = Layer.effect(
  StagedStorage,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const client = makeR2Client(config);
    const bucket = sharedBucketName(config);

    const stagedPrefix = (vaultId: Uuid) => `staging/${vaultId}/`;
    const stagedObjectKey = (vaultId: Uuid, hash: FileFingerprint) =>
      `${stagedPrefix(vaultId)}${hash}`;

    return {
      pruneExpiredStaged: () => Effect.void,
      prepareStagedPut: (vaultId, hash, contentType, contentLength) => {
        const key = stagedObjectKey(vaultId, hash);
        return Effect.tryPromise({
          try: () =>
            getSignedUrl(
              client,
              new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                ContentType: contentType,
                ContentLength: contentLength,
              }),
              { expiresIn: R2_STAGED_UPLOAD_EXPIRES_SECONDS },
            ),
          catch: (error) => error,
        }).pipe(
          Effect.mapError((error) => stagedStorageError("prepare", key, error)),
          Effect.map((url) => ({ transport: "presigned" as const, url })),
        );
      },
      writeStagedBytes: (vaultId, hash, bytes, contentType) => {
        const key = stagedObjectKey(vaultId, hash);
        return Effect.tryPromise({
          try: (signal) =>
            client.send(
              new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: bytes,
                ContentType: contentType,
                ContentLength: bytes.byteLength,
              }),
              { abortSignal: signal },
            ),
          catch: (error) => error,
        }).pipe(
          Effect.timeout(R2_WRITE_TIMEOUT),
          Effect.mapError((error) => stagedStorageError("write", key, error)),
          Effect.asVoid,
        );
      },
      readStagedBytes: (vaultId, hash) =>
        Effect.gen(function* () {
          const key = stagedObjectKey(vaultId, hash);
          const response = yield* Effect.tryPromise({
            try: (signal) =>
              client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
                abortSignal: signal,
              }),
            catch: (error) => error,
          }).pipe(
            Effect.timeout(R2_READ_TIMEOUT),
            Effect.mapError((error) =>
              isR2Missing(error) ? fileMissing(key) : stagedStorageError("read", key, error),
            ),
          );
          if (response.Body === undefined) {
            return yield* stagedStorageError(
              "read",
              key,
              new Error(`R2 object ${key} returned no body`),
            );
          }
          return yield* Effect.tryPromise({
            try: () => response.Body!.transformToByteArray(),
            catch: (error) => error,
          }).pipe(
            Effect.timeout(R2_READ_TIMEOUT),
            Effect.mapError((error) => stagedStorageError("read", key, error)),
          );
        }),
      deleteStaged: (vaultId, hash) => {
        const key = stagedObjectKey(vaultId, hash);
        return Effect.tryPromise({
          try: (signal) =>
            client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
              abortSignal: signal,
            }),
          catch: (error) => error,
        }).pipe(
          Effect.timeout(R2_WRITE_TIMEOUT),
          Effect.mapError((error) => stagedStorageError("delete", key, error)),
          Effect.asVoid,
        );
      },
      clearStaged: (vaultId) =>
        deleteR2Objects(client, bucket, stagedPrefix(vaultId)).pipe(Effect.orDie),
    } satisfies StagedStorageShape;
  }),
);

export const ContentStorageLive = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    config.storageBackend === "local" ? LocalContentStorageLive : R2ContentStorageLive,
  ),
);

export const StagedStorageLive = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    config.storageBackend === "local" ? LocalStagedStorageLive : R2StagedStorageLive,
  ),
);

const R2ProposalStorageLive = Layer.effect(
  ProposalStorage,
  Effect.map(AppConfig, (config) => {
    const driver = makeR2Driver(makeR2Client(config));
    const root = {
      kind: "r2" as const,
      bucket: sharedBucketName(config),
      keyPrefix: `${PROPOSALS_DIR}/`,
    };
    return {
      readText: (path) => driver.getText(root, path),
      writeText: (path, content) => driver.putText(root, path, content),
      deletePath: (path) => driver.remove(root, path),
    } satisfies ProposalStorageShape;
  }),
);

export const ProposalStorageLive = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    config.storageBackend === "local" ? LocalProposalStorageLive : R2ProposalStorageLive,
  ),
);
