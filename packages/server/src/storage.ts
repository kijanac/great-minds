import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { GetObjectCommand, NoSuchKey, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { Database, vaults } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";

import { AppConfig } from "./config.ts";

const VAULTS_DIR = "vaults";
const R2_READ_TIMEOUT = "30 seconds";

export class StorageFileMissing extends Schema.TaggedErrorClass<StorageFileMissing>()(
  "StorageFileMissing",
  {
    path: Schema.String,
  },
) {}

type VaultStorageShape = {
  readonly readText: (vaultId: Uuid, path: string) => Effect.Effect<string, StorageFileMissing>;
};

export class VaultStorage extends Context.Service<VaultStorage, VaultStorageShape>()(
  "@great-minds/server/VaultStorage",
) {}

const isWithinRoot = (root: string, child: string) => {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const fileMissing = (path: string) => new StorageFileMissing({ path });

const isNodeMissing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

export const LocalStorageLive = Layer.effect(
  VaultStorage,
  Effect.map(AppConfig, (config) => {
    const dataRoot = resolve(config.dataDir);

    return {
      readText: (vaultId, path) =>
        Effect.gen(function* () {
          const vaultRoot = resolve(dataRoot, VAULTS_DIR, vaultId);
          const fullPath = resolve(vaultRoot, path);
          if (!isWithinRoot(vaultRoot, fullPath)) {
            throw new Error(`Path escapes storage root: ${path}`);
          }
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
        }),
    } satisfies VaultStorageShape;
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

export const R2StorageLive = Layer.effect(
  VaultStorage,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const db = yield* Database;
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

    const vaultBucket = (vaultId: Uuid) =>
      Effect.gen(function* () {
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

    return {
      readText: (vaultId, path) =>
        Effect.gen(function* () {
          const bucket = yield* vaultBucket(vaultId);
          const key = `${VAULTS_DIR}/${vaultId}/${path}`;
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
        }),
    } satisfies VaultStorageShape;
  }),
);

export const VaultStorageLive = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    config.storageBackend === "local" ? LocalStorageLive : R2StorageLive,
  ),
);
