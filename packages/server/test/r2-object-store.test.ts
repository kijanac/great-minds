import { Readable } from "node:stream";

import { S3Client } from "@aws-sdk/client-s3";
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

  it("requires an ETag only for conditional reads", async () => {
    const bucket = makeFakeBucket({ omitEtag: true });
    bucket.write("wiki/a.md", encode("Readable\n"));
    const store = makeObjectStore(bucket.client, "bucket");
    expect(decode(await Effect.runPromise(store.get("wiki/a.md")))).toBe("Readable\n");
    expect(await Effect.runPromise(Effect.result(store.getVersioned("wiki/a.md")))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "StorageBackendError", errorType: "MissingVersion" },
    });
  });

  it("fails partial bulk deletion and lets a later attempt remove the remaining objects", async () => {
    const remaining = new Set(["vault/removed.md", "vault/denied.md"]);
    let deny = true;
    const client = new S3Client({
      region: "auto",
      endpoint: "http://fake-r2.invalid",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      forcePathStyle: true,
      requestHandler: {
        handle: async (request: { method: string }) => {
          let body: string;
          if (request.method === "GET") {
            body = `<ListBucketResult><IsTruncated>false</IsTruncated>${[...remaining].map((key) => `<Contents><Key>${key}</Key></Contents>`).join("")}</ListBucketResult>`;
          } else {
            expect(request.method).toBe("POST");
            const results = [...remaining].map((key) => {
              if (deny && key === "vault/denied.md")
                return `<Error><Key>${key}</Key><Code>AccessDenied</Code></Error>`;
              remaining.delete(key);
              return `<Deleted><Key>${key}</Key></Deleted>`;
            });
            body = `<DeleteResult>${results.join("")}</DeleteResult>`;
          }
          return {
            response: {
              statusCode: 200,
              headers: { "content-type": "application/xml" },
              body: Readable.from([body]),
            },
          };
        },
      },
    });
    try {
      const store = makeObjectStore(client, "bucket");
      const partial = await Effect.runPromise(Effect.result(store.removePrefix("vault/")));
      expect(partial).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "StorageBackendError",
          operation: "delete",
          key: "vault/",
          errorType: "PartialDelete",
        },
      });
      expect([...remaining]).toEqual(["vault/denied.md"]);
      deny = false;
      await Effect.runPromise(store.removePrefix("vault/"));
      expect(remaining.size).toBe(0);
    } finally {
      client.destroy();
    }
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
