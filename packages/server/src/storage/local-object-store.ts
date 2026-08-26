import { access, appendFile, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { Effect } from "effect";

import {
  ObjectMissing,
  type ObjectStore,
  storageBackendError,
} from "./object-store.ts";

const isNodeMissing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const isWithinRoot = (root: string, child: string) => {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const resolveKey = (root: string, key: string) => {
  const path = resolve(root, key);
  if (!isWithinRoot(root, path)) {
    throw new Error(`Object key escapes storage root: ${key}`);
  }
  return path;
};

export const makeLocalObjectStore = (directory: string): ObjectStore => {
  const root = resolve(directory);
  return {
    get: (key) =>
      Effect.tryPromise({
        try: () => readFile(resolveKey(root, key)),
        catch: (error) => error,
      }).pipe(
        Effect.mapError((error) =>
          isNodeMissing(error)
            ? new ObjectMissing({ key })
            : storageBackendError("read", key, error),
        ),
      ),
    put: (key, bytes) => {
      const path = resolveKey(root, key);
      return Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => mkdir(resolve(path, ".."), { recursive: true }),
          catch: (error) => storageBackendError("write", key, error),
        });
        yield* Effect.tryPromise({
          try: () => writeFile(path, bytes),
          catch: (error) => storageBackendError("write", key, error),
        });
      });
    },
    append: (key, bytes) => {
      const path = resolveKey(root, key);
      return Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => mkdir(resolve(path, ".."), { recursive: true }),
          catch: (error) => storageBackendError("write", key, error),
        });
        yield* Effect.tryPromise({
          try: () => appendFile(path, bytes),
          catch: (error) => storageBackendError("write", key, error),
        });
      });
    },
    remove: (key) =>
      Effect.tryPromise({
        try: () => unlink(resolveKey(root, key)),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          isNodeMissing(error)
            ? Effect.void
            : Effect.fail(storageBackendError("delete", key, error)),
        ),
      ),
    removePrefix: (prefix) =>
      Effect.tryPromise({
        try: () => rm(resolveKey(root, prefix), { recursive: true, force: true }),
        catch: (error) => storageBackendError("delete", prefix, error),
      }),
    list: (prefix, recursive) =>
      Effect.tryPromise({
        try: () => readdir(resolveKey(root, prefix), { recursive }),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          isNodeMissing(error)
            ? Effect.succeed([])
            : Effect.fail(storageBackendError("list", prefix, error)),
        ),
        Effect.map((entries) =>
          entries.map((entry) => ({ key: `${prefix}${entry}`, etag: null })),
        ),
      ),
    exists: (key) =>
      Effect.tryPromise({
        try: () => access(resolveKey(root, key)),
        catch: (error) => error,
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            isNodeMissing(error)
              ? Effect.succeed(false)
              : Effect.fail(storageBackendError("exists", key, error)),
          onSuccess: () => Effect.succeed(true),
        }),
      ),
  };
};

export const pruneLocalStaging = (directory: string, expiresBefore: number) => {
  const root = resolve(directory);
  const staging = resolveKey(root, "staging");
  const pruneDirectory = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const child = resolveKey(path, entry.name);
        if (entry.isDirectory()) return pruneDirectory(child);
        if (!entry.isFile()) return;
        try {
          const details = await stat(child);
          if (details.mtimeMs < expiresBefore) await unlink(child);
        } catch (error) {
          if (!isNodeMissing(error)) throw error;
        }
      }),
    );
  };
  return Effect.tryPromise({
    try: () => pruneDirectory(staging),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      isNodeMissing(error)
        ? Effect.void
        : Effect.fail(storageBackendError("delete", "staging/", error)),
    ),
  );
};
