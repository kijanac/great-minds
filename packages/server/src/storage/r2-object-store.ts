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
import { Effect, Option, Redacted } from "effect";

import type { AppConfig } from "../config.ts";
import {
  ObjectMissing,
  type ObjectStore,
  StorageBackendError,
  storageBackendError,
} from "./object-store.ts";

const READ_TIMEOUT = "30 seconds";
const WRITE_TIMEOUT = "120 seconds";
const ADMIN_TIMEOUT = "120 seconds";
const UPLOAD_EXPIRES_SECONDS = 3600;

const redactedOption = (value: Option.Option<Redacted.Redacted<string>>, label: string) =>
  Option.match(value, {
    onNone: () => {
      throw new Error(`R2 storage missing ${label}`);
    },
    onSome: Redacted.value,
  });

const stringOption = (value: Option.Option<string>, label: string) =>
  Option.match(value, {
    onNone: () => {
      throw new Error(`R2 storage missing ${label}`);
    },
    onSome: (raw) => raw,
  });

const isMissing = (error: unknown) => {
  if (error instanceof NoSuchKey) return true;
  return error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404;
};

const isAlreadyOwned = (error: unknown) =>
  error instanceof S3ServiceException && error.name === "BucketAlreadyOwnedByYou";

const storeFailure = (
  operation: "read" | "write" | "delete" | "list" | "exists" | "prepare",
  key: string,
  error: unknown,
) =>
  error instanceof StorageBackendError ? error : storageBackendError(operation, key, error);

type RequestTimeout = typeof READ_TIMEOUT | typeof WRITE_TIMEOUT | typeof ADMIN_TIMEOUT;

const request = <A>(
  timeout: RequestTimeout,
  run: (signal: AbortSignal) => Promise<A>,
) =>
  Effect.tryPromise({ try: run, catch: (error) => error }).pipe(Effect.timeout(timeout));

const objectRequest = <A>(
  operation: "read" | "write" | "delete" | "list" | "exists",
  key: string,
  timeout: RequestTimeout,
  run: (signal: AbortSignal) => Promise<A>,
) => request(timeout, run).pipe(Effect.mapError((error) => storeFailure(operation, key, error)));

const bucketName = (config: AppConfig["Service"]) =>
  stringOption(config.r2BucketName, "R2_BUCKET_NAME");

const makeClient = (config: AppConfig["Service"]) => {
  const accountId = stringOption(config.r2AccountId, "R2_ACCOUNT_ID");
  return new S3Client({
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    region: "auto",
    credentials: {
      accessKeyId: redactedOption(config.r2AccessKeyId, "R2_ACCESS_KEY_ID"),
      secretAccessKey: redactedOption(config.r2SecretAccessKey, "R2_SECRET_ACCESS_KEY"),
    },
  });
};

const deletePrefix = (client: S3Client, bucket: string, prefix: string) =>
  Effect.gen(function* () {
    let continuationToken: string | undefined;
    do {
      const page = yield* objectRequest("delete", prefix, WRITE_TIMEOUT, (signal) =>
        client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
          { abortSignal: signal },
        ),
      );
      const objects = (page.Contents ?? [])
        .flatMap((object) => (object.Key === undefined ? [] : [{ Key: object.Key }]));
      if (objects.length > 0) {
        yield* objectRequest("delete", prefix, WRITE_TIMEOUT, (signal) =>
          client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: objects, Quiet: true },
            }),
            { abortSignal: signal },
          ),
        );
      }
      continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
  });

const makeObjectStore = (client: S3Client, bucket: string): ObjectStore => {
  const get: ObjectStore["get"] = (key) =>
    Effect.gen(function* () {
      const response = yield* request(READ_TIMEOUT, (signal) =>
        client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
          abortSignal: signal,
        }),
      ).pipe(
        Effect.mapError((error) =>
          isMissing(error) ? new ObjectMissing({ key }) : storeFailure("read", key, error),
        ),
      );
      if (response.Body === undefined) {
        return yield* storageBackendError(
          "read",
          key,
          new Error(`R2 object ${key} returned no body`),
        );
      }
      return yield* Effect.tryPromise({
        try: () => response.Body!.transformToByteArray(),
        catch: (error) => storageBackendError("read", key, error),
      }).pipe(
        Effect.timeout(READ_TIMEOUT),
        Effect.mapError((error) => storeFailure("read", key, error)),
      );
    });

  const put: ObjectStore["put"] = (key, bytes, options) =>
    objectRequest("write", key, WRITE_TIMEOUT, (signal) =>
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: options?.contentType,
          ContentLength: bytes.byteLength,
        }),
        { abortSignal: signal },
      ),
    ).pipe(Effect.asVoid);

  return {
    get,
    put,
    append: (key, bytes, options) =>
      Effect.gen(function* () {
        const existing = yield* get(key).pipe(
          Effect.catchTag("ObjectMissing", () => Effect.succeed(new Uint8Array())),
        );
        const combined = new Uint8Array(existing.byteLength + bytes.byteLength);
        combined.set(existing);
        combined.set(bytes, existing.byteLength);
        yield* put(key, combined, options);
      }),
    remove: (key) =>
      objectRequest("delete", key, WRITE_TIMEOUT, (signal) =>
        client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
          abortSignal: signal,
        }),
      ).pipe(Effect.asVoid),
    removePrefix: (prefix) => deletePrefix(client, bucket, prefix),
    list: (prefix, recursive) =>
      Effect.gen(function* () {
        const files: { key: string; etag: string | null }[] = [];
        let continuationToken: string | undefined;
        do {
          const page = yield* objectRequest("list", prefix, ADMIN_TIMEOUT, (signal) =>
            client.send(
              new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken,
                ...(recursive ? {} : { Delimiter: "/" }),
              }),
              { abortSignal: signal },
            ),
          );
          for (const object of page.Contents ?? []) {
            if (object.Key === undefined) continue;
            files.push({
              key: object.Key,
              etag: object.ETag?.replaceAll('"', "") ?? null,
            });
          }
          continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
        } while (continuationToken !== undefined);
        return files;
      }),
    exists: (key) =>
      request(READ_TIMEOUT, (signal) =>
        client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
          abortSignal: signal,
        }),
      ).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            isMissing(error)
              ? Effect.succeed(false)
              : Effect.fail(storeFailure("exists", key, error)),
          onSuccess: () => Effect.succeed(true),
        }),
      ),
  };
};

export type R2ObjectStoreBackend = {
  readonly objects: ObjectStore;
  readonly prepareUpload: (
    key: string,
    contentType: string,
    contentLength: number,
  ) => Effect.Effect<string, StorageBackendError>;
};

export const makeR2ObjectStoreBackend = (
  config: AppConfig["Service"],
): R2ObjectStoreBackend => {
  const client = makeClient(config);
  const bucket = bucketName(config);
  return {
    objects: makeObjectStore(client, bucket),
    prepareUpload: (key, contentType, contentLength) =>
      Effect.tryPromise({
        try: () =>
          getSignedUrl(
            client,
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              ContentType: contentType,
              ContentLength: contentLength,
            }),
            { expiresIn: UPLOAD_EXPIRES_SECONDS },
          ),
        catch: (error) => storageBackendError("prepare", key, error),
      }),
  };
};

export const ensureR2Bucket = (config: AppConfig["Service"]) =>
  Effect.gen(function* () {
    const client = makeClient(config);
    const bucket = bucketName(config);
    const head = yield* Effect.result(
      request(ADMIN_TIMEOUT, (signal) =>
        client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal }),
      ),
    );
    if (head._tag === "Failure") {
      if (!isMissing(head.failure)) return yield* Effect.die(head.failure);
      const created = yield* Effect.result(
        request(ADMIN_TIMEOUT, (signal) =>
          client.send(new CreateBucketCommand({ Bucket: bucket }), { abortSignal: signal }),
        ),
      );
      if (created._tag === "Failure" && !isAlreadyOwned(created.failure)) {
        return yield* Effect.die(created.failure);
      }
    }
    if (config.corsOrigins.length > 0) {
      yield* request(ADMIN_TIMEOUT, (signal) =>
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
      ).pipe(Effect.orDie);
    }
    yield* request(ADMIN_TIMEOUT, (signal) =>
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
    ).pipe(Effect.orDie);
  });
