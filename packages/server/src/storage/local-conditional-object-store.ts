import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { Data, Effect, type Scope, Semaphore } from "effect";

import { rawFileHash } from "../crypto.ts";
import {
  type ConditionalObjectStore,
  ObjectMissing,
  ObjectVersionConflict,
  type StorageBackendError,
  storageBackendError,
} from "./object-store.ts";

export class LocalHistoryWriterBusy extends Data.TaggedError("LocalHistoryWriterBusy")<{
  readonly directory: string;
}> {}

const hasCode = (error: unknown, code: string) =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const unlinkIfPresent = async (path: string) => {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
};

const syncDirectory = async (directory: string) => {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const versionOf = (bytes: Uint8Array) => `sha256:${rawFileHash(bytes)}`;
const writerLockName = ".conversation-history.lock";

export const openLocalConditionalObjectStore = (
  directory: string,
): Effect.Effect<
  ConditionalObjectStore,
  LocalHistoryWriterBusy | StorageBackendError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const mutex = yield* Semaphore.make(1);
    const owner = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const { tryLock } = await import("fs-native-extensions");
          const root = await realpath(directory);
          const lock = await open(
            join(root, writerLockName),
            constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            if (!(await lock.stat()).isFile()) throw new Error("Invalid history lock file");
            if (!tryLock(lock.fd)) throw new LocalHistoryWriterBusy({ directory: root });
            return { root, lock, closed: false };
          } catch (error) {
            await lock.close();
            throw error;
          }
        },
        catch: (error) =>
          error instanceof LocalHistoryWriterBusy
            ? error
            : storageBackendError("prepare", directory, error),
      }),
      (state) =>
        mutex
          .withPermit(
            Effect.tryPromise({
              try: async () => {
                state.closed = true;
                await state.lock.close();
              },
              catch: (error) => storageBackendError("prepare", directory, error),
            }),
          )
          .pipe(Effect.orDie),
    );

    const objectPath = async (key: string, createParents: boolean) => {
      if (owner.closed) throw new Error("Local history writer is closed");
      const parts = key.split("/");
      if (
        parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\")) ||
        parts[0] === writerLockName
      ) {
        throw new Error("Invalid local history object key");
      }
      let parent = owner.root;
      for (const part of parts.slice(0, -1)) {
        const child = join(parent, part);
        if (createParents) {
          try {
            await mkdir(child, { mode: 0o700 });
          } catch (error) {
            if (!hasCode(error, "EEXIST")) throw error;
          }
          await syncDirectory(parent);
        }
        const details = await lstat(child);
        if (!details.isDirectory() || details.isSymbolicLink())
          throw new Error("Invalid local history directory");
        parent = child;
      }
      return join(parent, parts.at(-1)!);
    };

    const currentBytes = async (path: string): Promise<Uint8Array | null> => {
      try {
        const details = await lstat(path);
        if (!details.isFile() || details.isSymbolicLink())
          throw new Error("Invalid local history object");
        return await readFile(path);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return null;
        throw error;
      }
    };

    return {
      getVersioned: (key) =>
        mutex.withPermit(
          Effect.uninterruptible(
            Effect.tryPromise({
              try: async () => {
                const path = await objectPath(key, false);
                const bytes = await currentBytes(path);
                if (bytes === null) throw new ObjectMissing({ key });
                const handle = await open(path, "r");
                try {
                  await handle.sync();
                } finally {
                  await handle.close();
                }
                await syncDirectory(dirname(path));
                return { bytes, version: versionOf(bytes) };
              },
              catch: (error) =>
                error instanceof ObjectMissing || hasCode(error, "ENOENT")
                  ? new ObjectMissing({ key })
                  : storageBackendError("read", key, error),
            }),
          ),
        ),
      putIfVersion: (key, expectedVersion, bytes) =>
        mutex.withPermit(
          Effect.uninterruptible(
            Effect.tryPromise({
              try: async () => {
                const path = await objectPath(key, true);
                const current = await currentBytes(path);
                if ((current === null ? null : versionOf(current)) !== expectedVersion) {
                  throw new ObjectVersionConflict({ key });
                }
                const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
                const handle = await open(temporary, "wx", 0o600);
                try {
                  try {
                    await handle.writeFile(bytes);
                    await handle.sync();
                  } finally {
                    await handle.close();
                  }
                  await rename(temporary, path);
                  await syncDirectory(dirname(path));
                } finally {
                  await unlinkIfPresent(temporary);
                }
              },
              catch: (error) =>
                error instanceof ObjectVersionConflict
                  ? error
                  : storageBackendError("write", key, error),
            }),
          ),
        ),
    } satisfies ConditionalObjectStore;
  });
