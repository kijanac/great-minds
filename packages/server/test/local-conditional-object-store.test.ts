import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";

import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { openLocalConditionalObjectStore } from "../src/storage/local-conditional-object-store.ts";
import type { ConditionalObjectStore } from "../src/storage/object-store.ts";
import { expectBytes, failure, temporaryDirectory } from "./fixtures/history-storage.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const key = "sessions/test.jsonl";
const encode = (text: string) => new TextEncoder().encode(text);
const diskFailure = () => Object.assign(new Error("Injected disk failure"), { code: "EIO" });

const withLocal = <Value, Error>(
  use: (
    objects: ConditionalObjectStore,
    directory: string,
  ) => Effect.Effect<Value, Error, Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory;
        return yield* use(yield* openLocalConditionalObjectStore(directory), directory);
      }),
    ),
  );

beforeEach(() => {
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
});

describe("local history writer ownership", () => {
  it("rejects another owner, including one opening the same root through a symlink", () =>
    withLocal((_objects, directory) =>
      Effect.gen(function* () {
        expect(
          failure(yield* Effect.exit(openLocalConditionalObjectStore(directory))),
        ).toMatchObject({ _tag: "LocalHistoryWriterBusy" });
        const alias = join(directory, "alias");
        yield* Effect.promise(() => fs.symlink(directory, alias, "dir"));
        expect(failure(yield* Effect.exit(openLocalConditionalObjectStore(alias)))).toMatchObject({
          _tag: "LocalHistoryWriterBusy",
        });
      }),
    ));

  it("releases ownership on clean close and rejects use of the closed handle", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* temporaryDirectory;
          const closed = yield* Effect.scoped(
            Effect.gen(function* () {
              const objects = yield* openLocalConditionalObjectStore(directory);
              yield* objects.putIfVersion(key, null, encode("saved\n"));
              return objects;
            }),
          );
          expect(failure(yield* Effect.exit(closed.getVersioned(key)))).toMatchObject({
            _tag: "StorageBackendError",
          });
          expect(
            failure(yield* Effect.exit(closed.putIfVersion(key, null, encode("wrong\n")))),
          ).toMatchObject({ _tag: "StorageBackendError" });
          const lockBefore = yield* Effect.promise(() =>
            fs.stat(join(directory, ".conversation-history.lock")),
          );
          const reopened = yield* openLocalConditionalObjectStore(directory);
          expectBytes((yield* reopened.getVersioned(key)).bytes, encode("saved\n"));
          const lockAfter = yield* Effect.promise(() =>
            fs.stat(join(directory, ".conversation-history.lock")),
          );
          expect(lockAfter.ino).toBe(lockBefore.ino);
        }),
      ),
    ));

  it("does not use lock-file age to take ownership from a live writer", () =>
    withLocal((_objects, directory) =>
      Effect.gen(function* () {
        const lock = join(directory, ".conversation-history.lock");
        yield* Effect.promise(() => fs.utimes(lock, new Date(0), new Date(0)));
        expect(
          failure(yield* Effect.exit(openLocalConditionalObjectStore(directory))),
        ).toMatchObject({ _tag: "LocalHistoryWriterBusy" });
      }),
    ));

  it("rejects a symlink in place of the writer lock", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* temporaryDirectory;
          const target = join(directory, "not-a-lock");
          yield* Effect.promise(() => fs.writeFile(target, "unchanged"));
          yield* Effect.promise(() =>
            fs.symlink(target, join(directory, ".conversation-history.lock")),
          );
          expect(
            failure(yield* Effect.exit(openLocalConditionalObjectStore(directory))),
          ).toMatchObject({ _tag: "StorageBackendError" });
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("unchanged");
        }),
      ),
    ));

  it("finishes an in-flight replacement before cancellation can release ownership", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* temporaryDirectory;
          const ownedScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
            Scope.close(scope, Exit.succeed(undefined)),
          );
          const objects = yield* openLocalConditionalObjectStore(directory).pipe(
            Effect.provideService(Scope.Scope, ownedScope),
          );
          yield* objects.putIfVersion(key, null, encode("old\n"));
          const old = yield* objects.getVersioned(key);
          const reached = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
            await Effect.runPromise(Deferred.succeed(reached, undefined));
            await Effect.runPromise(Deferred.await(release));
            return actual.rename(from, to);
          });
          const writer = yield* Effect.forkChild(
            objects.putIfVersion(key, old.version, encode("new\n")),
          );
          yield* Deferred.await(reached);
          writer.interruptUnsafe();
          const closing = yield* Effect.forkChild(Scope.close(ownedScope, Exit.succeed(undefined)));
          try {
            expectBytes(
              yield* Effect.promise(() => actual.readFile(join(directory, key))),
              encode("old\n"),
            );
            expect(
              failure(yield* Effect.exit(openLocalConditionalObjectStore(directory))),
            ).toMatchObject({ _tag: "LocalHistoryWriterBusy" });
          } finally {
            yield* Deferred.succeed(release, undefined);
          }
          yield* Fiber.await(writer);
          yield* Fiber.join(closing);
          const reopened = yield* openLocalConditionalObjectStore(directory);
          expectBytes((yield* reopened.getVersioned(key)).bytes, encode("new\n"));
        }),
      ),
    ));
});

describe("local history file replacement", () => {
  it.each(["first write", "replacement"])(
    "keeps the destination intact if rename fails during %s",
    (phase) =>
      withLocal((objects, directory) =>
        Effect.gen(function* () {
          let version: string | null = null;
          if (phase === "replacement") {
            yield* objects.putIfVersion(key, null, encode("old\n"));
            version = (yield* objects.getVersioned(key)).version;
          }
          vi.mocked(fs.rename).mockRejectedValueOnce(diskFailure());
          const exit = yield* Effect.exit(objects.putIfVersion(key, version, encode("new\n")));
          expect(failure(exit)).toMatchObject({ _tag: "StorageBackendError", operation: "write" });
          if (phase === "replacement")
            expectBytes((yield* objects.getVersioned(key)).bytes, encode("old\n"));
          else
            expect(failure(yield* Effect.exit(objects.getVersioned(key)))).toMatchObject({
              _tag: "ObjectMissing",
            });
          const files = yield* Effect.promise(() => fs.readdir(dirname(join(directory, key))));
          expect(files).toEqual(phase === "replacement" ? ["test.jsonl"] : []);
        }),
      ),
  );

  it("retries a failed parent-directory flush even when the directory was already created", () =>
    withLocal((objects, directory) =>
      Effect.gen(function* () {
        let rootFlushes = 0;
        vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
          const handle = await actual.open(path, flags, mode);
          if (path === directory) {
            const sync = handle.sync.bind(handle);
            vi.spyOn(handle, "sync").mockImplementation(async () => {
              rootFlushes += 1;
              if (rootFlushes === 1) throw diskFailure();
              await sync();
            });
          }
          return handle;
        });
        expect(
          failure(yield* Effect.exit(objects.putIfVersion(key, null, encode("new\n")))),
        ).toMatchObject({ _tag: "StorageBackendError" });
        expect(failure(yield* Effect.exit(objects.getVersioned(key)))).toMatchObject({
          _tag: "ObjectMissing",
        });
        yield* objects.putIfVersion(key, null, encode("new\n"));
        expect(rootFlushes).toBe(2);
        expectBytes((yield* objects.getVersioned(key)).bytes, encode("new\n"));
      }),
    ));

  it("does not publish a replacement whose file flush failed", () =>
    withLocal((objects, directory) =>
      Effect.gen(function* () {
        yield* objects.putIfVersion(key, null, encode("old\n"));
        const old = yield* objects.getVersioned(key);
        vi.mocked(fs.rename).mockClear();
        vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
          const handle = await actual.open(path, flags, mode);
          if (typeof path === "string" && path.endsWith(".tmp"))
            vi.spyOn(handle, "sync").mockRejectedValueOnce(diskFailure());
          return handle;
        });
        expect(
          failure(yield* Effect.exit(objects.putIfVersion(key, old.version, encode("new\n")))),
        ).toMatchObject({ _tag: "StorageBackendError" });
        expect(fs.rename).not.toHaveBeenCalled();
        expectBytes((yield* objects.getVersioned(key)).bytes, encode("old\n"));
        expect(yield* Effect.promise(() => fs.readdir(join(directory, "sessions")))).toEqual([
          "test.jsonl",
        ]);
      }),
    ));

  it("does not confirm a renamed file until its directory can be flushed", () =>
    withLocal((objects, directory) =>
      Effect.gen(function* () {
        yield* objects.putIfVersion(key, null, encode("old\n"));
        const old = yield* objects.getVersioned(key);
        const parent = dirname(join(directory, key));
        vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
          const handle = await actual.open(path, flags, mode);
          if (path === parent) vi.spyOn(handle, "sync").mockRejectedValue(diskFailure());
          return handle;
        });
        expect(
          failure(yield* Effect.exit(objects.putIfVersion(key, old.version, encode("new\n")))),
        ).toMatchObject({ _tag: "StorageBackendError", operation: "write" });
        expectBytes(
          yield* Effect.promise(() => actual.readFile(join(directory, key))),
          encode("new\n"),
        );
        expect(failure(yield* Effect.exit(objects.getVersioned(key)))).toMatchObject({
          _tag: "StorageBackendError",
          operation: "read",
        });
        vi.mocked(fs.open).mockImplementation(actual.open);
        expectBytes((yield* objects.getVersioned(key)).bytes, encode("new\n"));
      }),
    ));

  it.each([
    "../escape.jsonl",
    "/absolute.jsonl",
    "nested/../../escape",
    "",
    "a\\b",
    ".conversation-history.lock",
  ])("rejects unsafe object key %s", (unsafeKey) =>
    withLocal((objects) =>
      Effect.gen(function* () {
        expect(
          failure(yield* Effect.exit(objects.putIfVersion(unsafeKey, null, encode("wrong\n")))),
        ).toMatchObject({ _tag: "StorageBackendError" });
        expect(failure(yield* Effect.exit(objects.getVersioned(unsafeKey)))).toMatchObject({
          _tag: "StorageBackendError",
        });
      }),
    ),
  );

  it("does not follow symlinks in object paths", () =>
    withLocal((objects, directory) =>
      Effect.gen(function* () {
        const outside = yield* temporaryDirectory;
        yield* Effect.promise(() => fs.symlink(outside, join(directory, "sessions"), "dir"));
        expect(
          failure(yield* Effect.exit(objects.putIfVersion(key, null, encode("wrong\n")))),
        ).toMatchObject({ _tag: "StorageBackendError" });
        expect(yield* Effect.promise(() => fs.readdir(outside))).toEqual([]);
        yield* Effect.promise(() => fs.unlink(join(directory, "sessions")));
        yield* Effect.promise(() => fs.mkdir(join(directory, "sessions")));
        const target = join(outside, "target.jsonl");
        yield* Effect.promise(() => fs.writeFile(target, "outside\n"));
        yield* Effect.promise(() => fs.symlink(target, join(directory, key)));
        expect(failure(yield* Effect.exit(objects.getVersioned(key)))).toMatchObject({
          _tag: "StorageBackendError",
        });
        expect(
          failure(yield* Effect.exit(objects.putIfVersion(key, null, encode("wrong\n")))),
        ).toMatchObject({ _tag: "StorageBackendError" });
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("outside\n");
      }),
    ));
});
