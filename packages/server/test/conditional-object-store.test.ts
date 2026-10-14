import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { makeObjectStore } from "../src/storage/r2-object-store.ts";
import { makeFakeBucket } from "./fixtures/fake-r2-bucket.ts";
import { backends, expectBytes, failure, withObjects } from "./fixtures/history-storage.ts";

const key = "vaults/test/sessions/conversation.jsonl";
const encode = (value: string) => new TextEncoder().encode(value);

for (const backend of backends)
  describe(`${backend} conditional object storage`, () => {
    it("requires the exact version and returns detached bytes without changing other keys", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          expect(failure(yield* Effect.exit(objects.getVersioned(key)))._tag).toBe("ObjectMissing");
          expect(
            failure(yield* Effect.exit(objects.putIfVersion(key, "missing", encode("wrong"))))._tag,
          ).toBe("ObjectVersionConflict");
          expect(failure(yield* Effect.exit(objects.getVersioned(key)))._tag).toBe("ObjectMissing");
          const input = encode("first é 漢字\n");
          yield* objects.putIfVersion(key, null, input);
          input.fill(0);
          const first = yield* objects.getVersioned(key);
          expectBytes(first.bytes, encode("first é 漢字\n"));
          first.bytes.fill(0);
          expectBytes((yield* objects.getVersioned(key)).bytes, encode("first é 漢字\n"));
          yield* objects.putIfVersion(`${key}.other`, null, encode("other"));
          yield* objects.putIfVersion(key, first.version, encode("replacement"));
          const saved = yield* objects.getVersioned(key);
          expectBytes(saved.bytes, encode("replacement"));
          expect(saved.version).not.toBe(first.version);
          for (const version of [null, first.version]) {
            expect(
              failure(yield* Effect.exit(objects.putIfVersion(key, version, encode("wrong"))))._tag,
            ).toBe("ObjectVersionConflict");
            expect(yield* objects.getVersioned(key)).toEqual(saved);
          }
          expectBytes((yield* objects.getVersioned(`${key}.other`)).bytes, encode("other"));
        }),
      ));

    it.each(["create", "replace"] as const)("admits exactly one simultaneous %s", (phase) =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          let version: string | null = null;
          if (phase === "replace") {
            yield* objects.putIfVersion(key, null, encode("base"));
            version = (yield* objects.getVersioned(key)).version;
          }
          const writes = [encode("one"), encode("two")];
          const results = yield* Effect.all(
            writes.map((bytes) => Effect.exit(objects.putIfVersion(key, version, bytes))),
            { concurrency: 2 },
          );
          expect(results.filter(Exit.isSuccess)).toHaveLength(1);
          expect(failure(results.find(Exit.isFailure)!)._tag).toBe("ObjectVersionConflict");
          expectBytes(
            (yield* objects.getVersioned(key)).bytes,
            writes[results.findIndex(Exit.isSuccess)],
          );
        }),
      ),
    );
  });

describe("R2 conditional request boundary", () => {
  it("preserves quoted ETags and distinguishes precondition, missing-version and service failures", async () => {
    const bucket = makeFakeBucket();
    const objects = makeObjectStore(bucket.client, "bucket");
    await Effect.runPromise(objects.putIfVersion(key, null, encode("one")));
    const first = await Effect.runPromise(objects.getVersioned(key));
    bucket.write(key, encode("concurrent"));
    expect(
      failure(
        await Effect.runPromise(
          Effect.exit(objects.putIfVersion(key, first.version, encode("two"))),
        ),
      )._tag,
    ).toBe("ObjectVersionConflict");
    expect(bucket.requests.filter((request) => request.method === "PUT")).toEqual([
      { method: "PUT", key, ifMatch: undefined, ifNoneMatch: "*" },
      { method: "PUT", key, ifMatch: '"v1"', ifNoneMatch: undefined },
    ]);
    const unversioned = makeFakeBucket({ omitEtag: true });
    unversioned.write(key, encode("one"));
    expect(
      failure(
        await Effect.runPromise(
          Effect.exit(makeObjectStore(unversioned.client, "bucket").getVersioned(key)),
        ),
      ),
    ).toMatchObject({ _tag: "StorageBackendError", operation: "read" });
    const unavailable = makeFakeBucket({
      beforePut: () => {
        throw new Error("Unavailable");
      },
    });
    expect(
      failure(
        await Effect.runPromise(
          Effect.exit(
            makeObjectStore(unavailable.client, "bucket").putIfVersion(key, null, encode("one")),
          ),
        ),
      ),
    ).toMatchObject({ _tag: "StorageBackendError", operation: "write" });
    expect(unavailable.objects.has(key)).toBe(false);
  });
});
