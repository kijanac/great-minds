import { Data, type Effect } from "effect";

import { errorDetails } from "../error-details.ts";

export type ObjectStoreOperation = "read" | "write" | "delete" | "list" | "exists" | "prepare";

export class ObjectMissing extends Data.TaggedError("ObjectMissing")<{
  readonly key: string;
}> {}

export class StorageBackendError extends Data.TaggedError("StorageBackendError")<{
  readonly operation: ObjectStoreOperation;
  readonly key: string;
  readonly errorType: string;
  readonly message: string;
}> {}

export const storageBackendError = (
  operation: ObjectStoreOperation,
  key: string,
  error: unknown,
) => {
  const details = errorDetails(error);
  return new StorageBackendError({
    operation,
    key,
    errorType: details.errorType,
    message: details.message,
  });
};

export type ObjectEntry = {
  readonly key: string;
  readonly etag: string | null;
};

export type PutObjectOptions = {
  readonly contentType?: string;
};

export type ObjectStore = {
  readonly get: (
    key: string,
  ) => Effect.Effect<Uint8Array, ObjectMissing | StorageBackendError>;
  readonly put: (
    key: string,
    bytes: Uint8Array,
    options?: PutObjectOptions,
  ) => Effect.Effect<void, StorageBackendError>;
  readonly append: (
    key: string,
    bytes: Uint8Array,
    options?: PutObjectOptions,
  ) => Effect.Effect<void, StorageBackendError>;
  readonly remove: (key: string) => Effect.Effect<void, StorageBackendError>;
  readonly removePrefix: (prefix: string) => Effect.Effect<void, StorageBackendError>;
  readonly list: (
    prefix: string,
    recursive: boolean,
  ) => Effect.Effect<readonly ObjectEntry[], StorageBackendError>;
  readonly exists: (key: string) => Effect.Effect<boolean, StorageBackendError>;
};
