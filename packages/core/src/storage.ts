import { Context, Data, Effect } from "effect";
import type { UserId } from "@great-minds/domain/user";
import type { VaultInternal } from "@great-minds/domain/vault";

export class StorageOperationFailed extends Data.TaggedError("StorageOperationFailed")<{
  operation: "prepareBucketForOwner" | "writeText" | "deleteText" | "clearVault";
  message: string;
}> {}

export type StorageWrite = {
  readonly etag: string | null;
};

export type VaultStorageService = {
  readonly prepareBucketForOwner: (
    ownerId: UserId,
  ) => Effect.Effect<string | null, StorageOperationFailed>;
  readonly writeText: (
    vault: VaultInternal,
    path: string,
    content: string,
  ) => Effect.Effect<StorageWrite, StorageOperationFailed>;
  readonly deleteText: (
    vault: VaultInternal,
    path: string,
  ) => Effect.Effect<void, StorageOperationFailed>;
  readonly clearVault: (vault: VaultInternal) => Effect.Effect<void, StorageOperationFailed>;
};

export class VaultStorage extends Context.Service<VaultStorage, VaultStorageService>()(
  "VaultStorage",
) {}
