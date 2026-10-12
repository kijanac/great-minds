import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeObjectStore } from "../src/storage/r2-object-store.ts";
import { makeFakeBucket } from "./fixtures/fake-r2-bucket.ts";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

describe("R2 whole-object storage", () => {
  it("creates and replaces an object without conditional write headers", async () => {
    const bucket = makeFakeBucket();
    const store = makeObjectStore(bucket.client, "bucket");
    await Effect.runPromise(store.put("wiki/a.md", encode("one\n")));
    await Effect.runPromise(store.put("wiki/a.md", encode("Updated 文本\n")));
    expect(decode(await Effect.runPromise(store.get("wiki/a.md")))).toBe("Updated 文本\n");
    expect(bucket.requests.filter((request) => request.method === "PUT")).toEqual([
      { method: "PUT", key: "wiki/a.md", ifMatch: undefined, ifNoneMatch: undefined },
      { method: "PUT", key: "wiki/a.md", ifMatch: undefined, ifNoneMatch: undefined },
    ]);
  });

  it("does not require an ETag for an ordinary read", async () => {
    const bucket = makeFakeBucket({ omitEtag: true });
    bucket.write("wiki/a.md", encode("Readable\n"));
    const store = makeObjectStore(bucket.client, "bucket");
    expect(decode(await Effect.runPromise(store.get("wiki/a.md")))).toBe("Readable\n");
  });

  it("distinguishes a missing object from a failed read", async () => {
    const bucket = makeFakeBucket({
      beforeGet: (key) => {
        if (key === "offline") throw new Error("Unavailable");
      },
    });
    const store = makeObjectStore(bucket.client, "bucket");
    expect(await Effect.runPromise(Effect.result(store.get("missing")))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ObjectMissing", key: "missing" },
    });
    expect(await Effect.runPromise(Effect.result(store.get("offline")))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "StorageBackendError", operation: "read", key: "offline" },
    });
  });
});
