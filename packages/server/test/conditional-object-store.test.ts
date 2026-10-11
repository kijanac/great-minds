import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { makeObjectStore } from "../src/storage/r2-object-store.ts";
import { makeFakeBucket } from "./fixtures/fake-r2-bucket.ts";
import { backends, expectBytes, failure, withObjects } from "./fixtures/history-storage.ts";

const key = "vaults/test/sessions/conversation.jsonl";
const encode = (value: string) => new TextEncoder().encode(value);

for (const backend of backends)
  describe(`${backend} conditional object storage`, () => {
    it("reports missing content rather than creating it on read", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(objects.getVersioned(key));
          expect(failure(exit)).toMatchObject({ _tag: "ObjectMissing", key });
        }),
      ));

    it("creates and replaces whole objects against their exact version", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          yield* objects.putIfVersion(key, null, encode("first\n"));
          const first = yield* objects.getVersioned(key);
          expectBytes(first.bytes, encode("first\n"));
          yield* objects.putIfVersion(key, first.version, encode("first\nsecond é 漢字\n"));
          const next = yield* objects.getVersioned(key);
          expectBytes(next.bytes, encode("first\nsecond é 漢字\n"));
          expect(next.version).not.toBe(first.version);
        }),
      ));

    it("rejects create-if-missing when the object already exists", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          yield* objects.putIfVersion(key, null, encode("original\n"));
          const rejected = yield* Effect.exit(
            objects.putIfVersion(key, null, encode("replacement\n")),
          );
          expect(failure(rejected)).toMatchObject({ _tag: "ObjectVersionConflict", key });
          expectBytes((yield* objects.getVersioned(key)).bytes, encode("original\n"));
        }),
      ));

    it("does not create an object when a missing object's version was expected", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const rejected = yield* Effect.exit(
            objects.putIfVersion(key, "stale-version", encode("wrong\n")),
          );
          expect(failure(rejected)).toMatchObject({ _tag: "ObjectVersionConflict" });
          expect(failure(yield* Effect.exit(objects.getVersioned(key)))).toMatchObject({
            _tag: "ObjectMissing",
          });
        }),
      ));

    it("rejects a stale version without overwriting a winning write", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          yield* objects.putIfVersion(key, null, encode("base\n"));
          const base = yield* objects.getVersioned(key);
          yield* objects.putIfVersion(key, base.version, encode("winner\n"));
          const rejected = yield* Effect.exit(
            objects.putIfVersion(key, base.version, encode("loser\n")),
          );
          expect(failure(rejected)).toMatchObject({ _tag: "ObjectVersionConflict" });
          expectBytes((yield* objects.getVersioned(key)).bytes, encode("winner\n"));
        }),
      ));

    it("admits exactly one of two simultaneous writes against the same version", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          yield* objects.putIfVersion(key, null, encode("base\n"));
          const base = yield* objects.getVersioned(key);
          const writes = [encode("one\n"), encode("two\n")];
          const results = yield* Effect.all(
            writes.map((bytes) => Effect.exit(objects.putIfVersion(key, base.version, bytes))),
            { concurrency: 2 },
          );
          expect(results.filter(Exit.isSuccess)).toHaveLength(1);
          const losing = results.find(Exit.isFailure)!;
          expect(failure(losing)).toMatchObject({ _tag: "ObjectVersionConflict" });
          const winner = results.findIndex(Exit.isSuccess);
          expectBytes((yield* objects.getVersioned(key)).bytes, writes[winner]);
        }),
      ));

    it("admits exactly one of two simultaneous object creations", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const results = yield* Effect.all(
            [
              Effect.exit(objects.putIfVersion(key, null, encode("one\n"))),
              Effect.exit(objects.putIfVersion(key, null, encode("two\n"))),
            ],
            { concurrency: 2 },
          );
          expect(results.filter(Exit.isSuccess)).toHaveLength(1);
          expect(failure(results.find(Exit.isFailure)!)).toMatchObject({
            _tag: "ObjectVersionConflict",
          });
        }),
      ));

    it("keeps versions and content independent between object keys", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          yield* objects.putIfVersion(key, null, encode("one\n"));
          const original = yield* objects.getVersioned(key);
          yield* objects.putIfVersion(`${key}.other`, null, encode("other\n"));
          expect(yield* objects.getVersioned(key)).toEqual(original);
          yield* objects.putIfVersion(key, original.version, encode("two\n"));
          expectBytes((yield* objects.getVersioned(`${key}.other`)).bytes, encode("other\n"));
        }),
      ));

    it("returns detached bytes rather than writable storage memory", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const input = encode("original\n");
          yield* objects.putIfVersion(key, null, input);
          input.fill(0);
          const read = yield* objects.getVersioned(key);
          read.bytes.fill(0);
          expectBytes((yield* objects.getVersioned(key)).bytes, encode("original\n"));
        }),
      ));
  });

describe("R2 conditional request boundary", () => {
  it("passes opaque quoted ETags unchanged and does not retry a precondition conflict", async () => {
    const bucket = makeFakeBucket();
    const objects = makeObjectStore(bucket.client, "bucket");
    await Effect.runPromise(objects.putIfVersion(key, null, encode("one\n")));
    const first = await Effect.runPromise(objects.getVersioned(key));
    bucket.write(key, encode("concurrent\n"));
    const exit = await Effect.runPromise(
      Effect.exit(objects.putIfVersion(key, first.version, encode("two\n"))),
    );
    expect(failure(exit)).toMatchObject({ _tag: "ObjectVersionConflict" });
    expect(bucket.requests.filter((request) => request.method === "PUT")).toEqual([
      { method: "PUT", key, ifMatch: undefined, ifNoneMatch: "*" },
      { method: "PUT", key, ifMatch: '"v1"', ifNoneMatch: undefined },
    ]);
  });

  it("refuses a conditional read without a backend version", async () => {
    const bucket = makeFakeBucket({ omitEtag: true });
    bucket.write(key, encode("one\n"));
    const exit = await Effect.runPromise(
      Effect.exit(makeObjectStore(bucket.client, "bucket").getVersioned(key)),
    );
    expect(failure(exit)).toMatchObject({ _tag: "StorageBackendError", operation: "read" });
  });

  it("keeps a rejected service request distinct from a version conflict", async () => {
    const bucket = makeFakeBucket({
      beforePut: () => {
        throw new Error("Service unavailable");
      },
    });
    const exit = await Effect.runPromise(
      Effect.exit(
        makeObjectStore(bucket.client, "bucket").putIfVersion(key, null, encode("one\n")),
      ),
    );
    expect(failure(exit)).toMatchObject({ _tag: "StorageBackendError", operation: "write" });
    expect(bucket.objects.has(key)).toBe(false);
  });
});
