import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Effect } from "effect";
import { StorageOperationFailed, type VaultStorageService } from "@great-minds/core";
import type { VaultInternal } from "@great-minds/domain/vault";
import type { StorageConfig } from "./context.js";

const R2_BATCH_DELETE_LIMIT = 1000;
const R2_MAX_BUCKET_NAME_LENGTH = 63;
const R2_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export function createVaultStorage(config: StorageConfig): VaultStorageService {
  if (config.kind === "local") {
    return {
      prepareBucketForOwner: () => Effect.succeed(null),
      writeText: (vault, filePath, content) =>
        writeLocalText(config.dataDir, vault, filePath, content),
      deleteText: (vault, filePath) => deleteLocalText(config.dataDir, vault, filePath),
      clearVault: (vault) => clearLocalVault(config.dataDir, vault),
    };
  }

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    prepareBucketForOwner: (ownerId) =>
      prepareR2BucketForOwner(client, config.bucketPrefix, ownerId),
    writeText: (vault, filePath, content) => writeR2Text(client, vault, filePath, content),
    deleteText: (vault, filePath) => deleteR2Text(client, vault, filePath),
    clearVault: (vault) => clearR2Vault(client, vault),
  };
}

function prepareR2BucketForOwner(
  client: S3Client,
  bucketPrefix: string,
  ownerId: string,
): Effect.Effect<string, StorageOperationFailed> {
  return Effect.gen(function* () {
    const bucket = yield* Effect.try({
      try: () => userBucketName(bucketPrefix, ownerId),
      catch: () =>
        new StorageOperationFailed({
          operation: "prepareBucketForOwner",
          message: "Invalid R2 bucket configuration",
        }),
    });

    yield* ensureR2Bucket(client, bucket);

    return bucket;
  });
}

function ensureR2Bucket(
  client: S3Client,
  bucket: string,
): Effect.Effect<void, StorageOperationFailed> {
  return Effect.gen(function* () {
    const exists = yield* r2BucketExists(client, bucket);
    if (!exists) yield* createR2Bucket(client, bucket).pipe(Effect.ignore);
    yield* applyR2Lifecycle(client, bucket);
  });
}

function r2BucketExists(
  client: S3Client,
  bucket: string,
): Effect.Effect<boolean, StorageOperationFailed> {
  return sendR2(
    () => client.send(new HeadBucketCommand({ Bucket: bucket })),
    "prepareBucketForOwner",
  ).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
}

function createR2Bucket(
  client: S3Client,
  bucket: string,
): Effect.Effect<unknown, StorageOperationFailed> {
  return sendR2(
    () => client.send(new CreateBucketCommand({ Bucket: bucket })),
    "prepareBucketForOwner",
  );
}

function applyR2Lifecycle(
  client: S3Client,
  bucket: string,
): Effect.Effect<unknown, StorageOperationFailed> {
  return sendR2(
    () =>
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
      ),
    "prepareBucketForOwner",
  );
}

function sendR2<T>(
  operation: () => Promise<T>,
  storageOperation: StorageOperationFailed["operation"],
): Effect.Effect<T, StorageOperationFailed> {
  return Effect.tryPromise({
    try: operation,
    catch: () =>
      new StorageOperationFailed({
        operation: storageOperation,
        message: storageFailureMessage(storageOperation),
      }),
  });
}

function storageFailureMessage(operation: StorageOperationFailed["operation"]): string {
  if (operation === "writeText") return "Failed to write vault storage";
  if (operation === "deleteText") return "Failed to delete vault storage";
  if (operation === "clearVault") return "Failed to clear vault storage";
  return "Failed to prepare vault storage";
}

function writeLocalText(
  dataDir: string,
  vault: VaultInternal,
  filePath: string,
  content: string,
): Effect.Effect<{ etag: null }, StorageOperationFailed> {
  return Effect.tryPromise({
    try: async () => {
      const fullPath = localVaultPath(dataDir, vault, filePath);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, { encoding: "utf-8" });
      return { etag: null };
    },
    catch: () =>
      new StorageOperationFailed({
        operation: "writeText",
        message: "Failed to write vault storage",
      }),
  });
}

function writeR2Text(
  client: S3Client,
  vault: VaultInternal,
  filePath: string,
  content: string,
): Effect.Effect<{ etag: string | null }, StorageOperationFailed> {
  return Effect.gen(function* () {
    if (!vault.storageBucketName) {
      return yield* Effect.fail(
        new StorageOperationFailed({
          operation: "writeText",
          message: "Vault has no storage bucket name",
        }),
      );
    }

    const bucket = vault.storageBucketName;
    const result = yield* sendR2(
      () =>
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `vaults/${vault.id}/${filePath}`,
            Body: content,
            ContentType: "text/markdown; charset=utf-8",
          }),
        ),
      "writeText",
    );
    return { etag: result.ETag ?? null };
  });
}

function deleteLocalText(
  dataDir: string,
  vault: VaultInternal,
  filePath: string,
): Effect.Effect<void, StorageOperationFailed> {
  return Effect.tryPromise({
    try: () => rm(localVaultPath(dataDir, vault, filePath), { force: true }),
    catch: () =>
      new StorageOperationFailed({
        operation: "deleteText",
        message: "Failed to delete vault storage",
      }),
  });
}

function deleteR2Text(
  client: S3Client,
  vault: VaultInternal,
  filePath: string,
): Effect.Effect<void, StorageOperationFailed> {
  return Effect.gen(function* () {
    if (!vault.storageBucketName) {
      return yield* Effect.fail(
        new StorageOperationFailed({
          operation: "deleteText",
          message: "Vault has no storage bucket name",
        }),
      );
    }

    const bucket = vault.storageBucketName;
    yield* sendR2(
      () =>
        client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: `vaults/${vault.id}/${filePath}`,
          }),
        ),
      "deleteText",
    );
  });
}

function clearLocalVault(
  dataDir: string,
  vault: VaultInternal,
): Effect.Effect<void, StorageOperationFailed> {
  return Effect.tryPromise({
    try: () => rm(localVaultRoot(dataDir, vault), { recursive: true, force: true }),
    catch: () =>
      new StorageOperationFailed({
        operation: "clearVault",
        message: "Failed to clear vault storage",
      }),
  });
}

function localVaultRoot(dataDir: string, vault: VaultInternal): string {
  const vaultsRoot = path.resolve(dataDir, "vaults");
  const vaultRoot = path.resolve(vaultsRoot, vault.id);
  if (!vaultRoot.startsWith(`${vaultsRoot}${path.sep}`)) {
    throw new Error(`Vault storage path escapes data directory: ${vault.id}`);
  }
  return vaultRoot;
}

function localVaultPath(dataDir: string, vault: VaultInternal, filePath: string): string {
  const root = localVaultRoot(dataDir, vault);
  const resolved = path.resolve(root, filePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Vault storage path escapes vault root: ${filePath}`);
  }
  return resolved;
}

function clearR2Vault(
  client: S3Client,
  vault: VaultInternal,
): Effect.Effect<void, StorageOperationFailed> {
  return Effect.tryPromise({
    try: async () => {
      if (!vault.storageBucketName) throw new Error(`Vault ${vault.id} has no storage bucket name`);
      const bucket = vault.storageBucketName;
      const prefix = `vaults/${vault.id}/`;
      let continuationToken: string | undefined;

      do {
        const listed = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        const objects = (listed.Contents ?? [])
          .map((object) => object.Key)
          .filter((key): key is string => Boolean(key))
          .slice(0, R2_BATCH_DELETE_LIMIT)
          .map((Key) => ({ Key }));

        if (objects.length > 0) {
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: objects, Quiet: true },
            }),
          );
        }

        continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (continuationToken);
    },
    catch: () =>
      new StorageOperationFailed({
        operation: "clearVault",
        message: "Failed to clear vault storage",
      }),
  });
}

function userBucketName(prefix: string, ownerId: string): string {
  const ownerIdHex = ownerId.replaceAll("-", "");
  const bucketName = `${prefix}-${ownerIdHex}`;

  if (bucketName.length > R2_MAX_BUCKET_NAME_LENGTH) {
    throw new Error(`R2 bucket name is too long: ${bucketName}`);
  }
  if (!R2_BUCKET_NAME_PATTERN.test(bucketName)) {
    throw new Error(`Invalid R2 bucket name: ${bucketName}`);
  }

  return bucketName;
}
