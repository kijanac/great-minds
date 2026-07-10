import { appendFile, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  CreateBucketCommand,
  DeleteBucketCommand,
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
import { Database, users, vaults } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { eq } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Option, Redacted, Schema } from "effect";

import { AppConfig } from "./config.ts";
import { StructuredLogger } from "./logging.ts";

const VAULTS_DIR = "vaults";
const PROPOSALS_DIR = "proposals";
const R2_READ_TIMEOUT = "30 seconds";
const R2_WRITE_TIMEOUT = "120 seconds";
const R2_ADMIN_TIMEOUT = "120 seconds";
const R2_MAX_BUCKET_NAME_LEN = 63;
const R2_STAGED_UPLOAD_EXPIRES_SECONDS = 3600;

export class StorageFileMissing extends Schema.TaggedErrorClass<StorageFileMissing>()(
  "StorageFileMissing",
  {
    path: Schema.String,
  },
) {}

type VaultStorageShape = {
  readonly readText: (
    vaultId: Uuid,
    path: string,
    bucketName?: string | null,
  ) => Effect.Effect<string, StorageFileMissing>;
  readonly writeText: (
    vaultId: Uuid,
    path: string,
    content: string,
    bucketName?: string | null,
  ) => Effect.Effect<void>;
  readonly appendText: (
    vaultId: Uuid,
    path: string,
    content: string,
    bucketName?: string | null,
  ) => Effect.Effect<void>;
  readonly exists: (vaultId: Uuid, path: string, bucketName?: string | null) => Effect.Effect<boolean>;
  readonly deletePath: (vaultId: Uuid, path: string) => Effect.Effect<void>;
  readonly clearVault: (vaultId: Uuid, bucketName: string | null) => Effect.Effect<void>;
  readonly prepareBucketForOwner: (ownerId: Uuid) => Effect.Effect<string | null>;
  readonly deleteOwnerBucket: (bucketName: string | null) => Effect.Effect<void>;
  readonly presignStagedPut: (
    vaultId: Uuid,
    bucketName: string,
    hash: string,
    contentType: string,
    contentLength: number,
  ) => Effect.Effect<string>;
};

export class VaultStorage extends Context.Service<VaultStorage, VaultStorageShape>()(
  "@great-minds/server/VaultStorage",
) {}

type ProposalStorageShape = {
  readonly readText: (path: string) => Effect.Effect<string, StorageFileMissing>;
  readonly writeText: (path: string, content: string) => Effect.Effect<void>;
  readonly exists: (path: string) => Effect.Effect<boolean>;
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

const localRoot = (dataRoot: string, vaultId: Uuid) => resolve(dataRoot, VAULTS_DIR, vaultId);

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

export const LocalStorageLive = Layer.effect(
  VaultStorage,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const logger = yield* StructuredLogger;
    const dataRoot = resolve(config.dataDir);

    return {
      readText: (vaultId, path) => readLocalText(localRoot(dataRoot, vaultId), path),
      writeText: (vaultId, path, content) => writeLocalText(localRoot(dataRoot, vaultId), path, content),
      appendText: (vaultId, path, content) =>
        appendLocalText(localRoot(dataRoot, vaultId), path, content),
      exists: (vaultId, path) => localExists(localRoot(dataRoot, vaultId), path),
      deletePath: (vaultId, path) => deleteLocalPath(localRoot(dataRoot, vaultId), path),
      clearVault: (vaultId, bucketName) =>
        Effect.tryPromise({
          try: () => rm(localRoot(dataRoot, vaultId), { recursive: true, force: true }),
          catch: (error) => error,
        }).pipe(
          Effect.catchCause((cause) =>
            logger
              .error("local_storage.clear_vault_failed", {
                vault_id: vaultId,
                bucket: bucketName,
                error: "Cause",
                error_message: Cause.pretty(cause),
              })
              .pipe(Effect.andThen(Effect.failCause(cause))),
          ),
          Effect.orDie,
        ),
      prepareBucketForOwner: () => Effect.succeed(null),
      deleteOwnerBucket: (bucketName) =>
        logger.info("storage.delete_owner_bucket_skipped", {
          bucket: bucketName,
          storage_backend: "local",
          reason: "local_storage",
        }),
      presignStagedPut: (vaultId) =>
        Effect.die(new Error(`Vault ${vaultId} has no R2 bucket name`)),
    } satisfies VaultStorageShape;
  }),
);

export const ProposalStorageLive = Layer.effect(
  ProposalStorage,
  Effect.map(AppConfig, (config) => {
    const root = resolve(config.dataDir, PROPOSALS_DIR);
    return {
      readText: (path) => readLocalText(root, path),
      writeText: (path, content) => writeLocalText(root, path, content),
      exists: (path) => localExists(root, path),
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

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const deriveUserBucketName = (prefix: string, userId: Uuid) => {
  const name = `${prefix}-${userId.replaceAll("-", "")}`;
  if (name.length > R2_MAX_BUCKET_NAME_LEN) {
    throw new Error(
      `r2 bucket prefix produces ${name.length}-character bucket name, max ${R2_MAX_BUCKET_NAME_LEN}`,
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name)) {
    throw new Error(`r2 bucket prefix produces invalid bucket name: ${name}`);
  }
  return name;
};

export const R2StorageLive = Layer.effect(
  VaultStorage,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const db = yield* Database;
    const logger = yield* StructuredLogger;
    const accountId = stringOption(config.r2AccountId, "R2_ACCOUNT_ID");
    const accessKeyId = redactedOption(config.r2AccessKeyId, "R2_ACCESS_KEY_ID");
    const secretAccessKey = redactedOption(config.r2SecretAccessKey, "R2_SECRET_ACCESS_KEY");
    const client = new S3Client({
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      region: "auto",
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    const vaultBucket = (vaultId: Uuid, bucketName?: string | null) =>
      Effect.gen(function* () {
        if (bucketName !== undefined && bucketName !== null && bucketName.length > 0) {
          return bucketName;
        }
        const rows = yield* db
          .select({ bucket: vaults.r2BucketName })
          .from(vaults)
          .where(eq(vaults.id, vaultId))
          .limit(1)
          .pipe(Effect.orDie);
        const row = rows[0];
        if (row?.bucket === undefined || row.bucket === null || row.bucket === "") {
          throw new Error(`Vault ${vaultId} has no R2 bucket name`);
        }
        return row.bucket;
      });

    const objectKey = (vaultId: Uuid, path: string) => `${VAULTS_DIR}/${vaultId}/${path}`;

    const objectPrefix = (vaultId: Uuid) => `${VAULTS_DIR}/${vaultId}/`;

    const stagedObjectKey = (vaultId: Uuid, hash: string) => `staging/${vaultId}/${hash}`;

    const sendAdmin = <A>(effect: Effect.Effect<A, unknown>) => effect.pipe(Effect.timeout(R2_ADMIN_TIMEOUT));

    const ensureBucket = (bucket: string) => {
      const startedAt = Date.now();
      let createdBucket = false;
      return Effect.gen(function* () {
        const head = yield* Effect.result(
          Effect.tryPromise({
            try: (signal) => client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal }),
            catch: (error) => error,
          }).pipe(Effect.timeout(R2_ADMIN_TIMEOUT)),
        );
        if (head._tag === "Failure") {
          if (isR2Missing(head.failure)) {
            createdBucket = true;
            const created = yield* Effect.result(
              Effect.tryPromise({
                try: (signal) =>
                  client.send(new CreateBucketCommand({ Bucket: bucket }), { abortSignal: signal }),
                catch: (error) => error,
              }).pipe(Effect.timeout(R2_ADMIN_TIMEOUT)),
            );
            if (created._tag === "Failure" && !isR2AlreadyOwned(created.failure)) {
              return yield* Effect.fail(created.failure);
            }
          } else {
            return yield* Effect.fail(head.failure);
          }
        }

        if (config.corsOrigins.length > 0) {
          yield* sendAdmin(
            Effect.tryPromise((signal) =>
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
            ),
          );
        }
        yield* sendAdmin(
          Effect.tryPromise((signal) =>
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
          ),
        );
        yield* logger.info("r2_admin.ensure_bucket", {
          bucket,
          created: createdBucket,
          latency_ms: Date.now() - startedAt,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          logger
            .warn("r2_admin.ensure_bucket", {
              bucket,
              error: "Cause",
              error_message: Cause.pretty(cause),
              latency_ms: Date.now() - startedAt,
            })
            .pipe(Effect.andThen(Effect.failCause(cause))),
        ),
        Effect.orDie,
      );
    };

    const deleteObjects = (bucket: string, prefix?: string) =>
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

    const deleteBucket = (bucket: string) =>
      Effect.tryPromise({
        try: (signal) =>
          client.send(new DeleteBucketCommand({ Bucket: bucket }), { abortSignal: signal }),
        catch: (error) => error,
      }).pipe(Effect.timeout(R2_ADMIN_TIMEOUT));

    const readR2Text = (vaultId: Uuid, path: string, bucketName?: string | null) =>
      Effect.gen(function* () {
        const bucket = yield* vaultBucket(vaultId, bucketName);
        const key = objectKey(vaultId, path);
        const responseResult = yield* Effect.result(
          Effect.tryPromise({
            try: (signal) =>
              client.send(
                new GetObjectCommand({
                  Bucket: bucket,
                  Key: key,
                }),
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

    const writeR2Text = (
      vaultId: Uuid,
      path: string,
      content: string,
      bucketName?: string | null,
    ) =>
      Effect.gen(function* () {
        const bucket = yield* vaultBucket(vaultId, bucketName);
        yield* Effect.tryPromise((signal) =>
          client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: objectKey(vaultId, path),
              Body: content,
              ContentType: path.endsWith(".md") ? "text/markdown" : "text/plain",
            }),
            { abortSignal: signal },
          ),
        ).pipe(Effect.timeout(R2_WRITE_TIMEOUT), Effect.orDie);
      });

    return {
      readText: readR2Text,
      writeText: writeR2Text,
      appendText: (vaultId, path, content, bucketName) =>
        Effect.gen(function* () {
          const existing = yield* Effect.result(readR2Text(vaultId, path, bucketName));
          const prefix = existing._tag === "Success" ? existing.success : "";
          yield* writeR2Text(vaultId, path, `${prefix}${content}`, bucketName);
        }),
      exists: (vaultId, path, bucketName) =>
        Effect.gen(function* () {
          const bucket = yield* vaultBucket(vaultId, bucketName);
          const result = yield* Effect.result(
            Effect.tryPromise({
              try: (signal) =>
                client.send(
                  new HeadObjectCommand({ Bucket: bucket, Key: objectKey(vaultId, path) }),
                  { abortSignal: signal },
                ),
              catch: (error) => error,
            }).pipe(Effect.timeout(R2_READ_TIMEOUT)),
          );
          if (result._tag === "Success") {
            return true;
          }
          if (isR2Missing(result.failure)) {
            return false;
          }
          throw result.failure;
        }),
      deletePath: (vaultId, path) =>
        Effect.gen(function* () {
          const bucket = yield* vaultBucket(vaultId);
          yield* Effect.tryPromise((signal) =>
            client.send(
              new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(vaultId, path) }),
              { abortSignal: signal },
            ),
          ).pipe(Effect.timeout(R2_WRITE_TIMEOUT), Effect.orDie);
        }),
      clearVault: (vaultId, bucketName) =>
        Effect.gen(function* () {
          if (bucketName === null || bucketName.length === 0) {
            const error = new Error(`Vault ${vaultId} has no R2 bucket name`);
            yield* logger.error("r2_storage.clear_vault_failed", {
              vault_id: vaultId,
              bucket: bucketName,
              error: error.name,
              error_message: error.message,
            });
            throw error;
          }
          const bucket = bucketName;
          yield* deleteObjects(bucket, objectPrefix(vaultId)).pipe(
            Effect.catchCause((cause) =>
              logger
                .error("r2_storage.clear_vault_failed", {
                  vault_id: vaultId,
                  bucket,
                  error: "Cause",
                  error_message: Cause.pretty(cause),
                })
                .pipe(Effect.andThen(Effect.failCause(cause))),
            ),
            Effect.orDie,
          );
        }),
      prepareBucketForOwner: (ownerId) =>
        Effect.gen(function* () {
          const userRows = yield* db
            .select({ bucket: users.r2BucketName })
            .from(users)
            .where(eq(users.id, ownerId))
            .limit(1)
            .pipe(Effect.orDie);
          const existing = userRows[0]?.bucket;
          if (existing !== undefined && existing !== null && existing.length > 0) {
            return existing;
          }
          const bucket = deriveUserBucketName(config.r2BucketPrefix, ownerId);
          yield* ensureBucket(bucket);
          yield* db
            .update(users)
            .set({ r2BucketName: bucket })
            .where(eq(users.id, ownerId))
            .pipe(Effect.orDie);
          return bucket;
        }),
      deleteOwnerBucket: (bucketName) =>
        Effect.gen(function* () {
          if (bucketName === null || bucketName.length === 0) {
            yield* logger.warn("r2_admin.delete_bucket", {
              bucket: bucketName,
              deleted: false,
              skipped: true,
              reason: "missing_bucket",
            });
            return;
          }

          const startedAt = Date.now();
          const emptyResult = yield* Effect.result(deleteObjects(bucketName));
          if (emptyResult._tag === "Failure") {
            if (isR2Missing(emptyResult.failure)) {
              yield* logger.info("r2_admin.delete_bucket", {
                bucket: bucketName,
                deleted: false,
                latency_ms: Date.now() - startedAt,
              });
              return;
            }
            yield* logger
              .warn("r2_admin.delete_bucket", {
                bucket: bucketName,
                error: errorName(emptyResult.failure),
                error_message: errorMessage(emptyResult.failure),
                latency_ms: Date.now() - startedAt,
              })
              .pipe(Effect.andThen(Effect.die(emptyResult.failure)));
          }

          const deleteResult = yield* Effect.result(deleteBucket(bucketName));
          if (deleteResult._tag === "Failure") {
            if (isR2Missing(deleteResult.failure)) {
              yield* logger.info("r2_admin.delete_bucket", {
                bucket: bucketName,
                deleted: false,
                latency_ms: Date.now() - startedAt,
              });
              return;
            }
            yield* logger
              .warn("r2_admin.delete_bucket", {
                bucket: bucketName,
                error: errorName(deleteResult.failure),
                error_message: errorMessage(deleteResult.failure),
                latency_ms: Date.now() - startedAt,
              })
              .pipe(Effect.andThen(Effect.die(deleteResult.failure)));
          }

          yield* logger.info("r2_admin.delete_bucket", {
            bucket: bucketName,
            deleted: true,
            latency_ms: Date.now() - startedAt,
          });
        }),
      presignStagedPut: (vaultId, bucketName, hash, contentType, contentLength) =>
        Effect.tryPromise(() =>
          getSignedUrl(
            client,
            new PutObjectCommand({
              Bucket: bucketName,
              Key: stagedObjectKey(vaultId, hash),
              ContentType: contentType,
              ContentLength: contentLength,
            }),
            {
              expiresIn: R2_STAGED_UPLOAD_EXPIRES_SECONDS,
            },
          ),
        ).pipe(Effect.orDie),
    } satisfies VaultStorageShape;
  }),
);

export const VaultStorageLive = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    config.storageBackend === "local" ? LocalStorageLive : R2StorageLive,
  ),
);
