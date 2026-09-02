import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeObjectStore } from "../src/storage/r2-object-store.ts";

type Stored = { bytes: Uint8Array; etag: string };

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

const preconditionFailed = () =>
  new S3ServiceException({
    name: "PreconditionFailed",
    $fault: "client",
    $metadata: { httpStatusCode: 412 },
  });

const makeFakeBucket = (hooks: { beforePut?: (key: string) => void } = {}) => {
  const objects = new Map<string, Stored>();
  let version = 0;
  const write = (key: string, bytes: Uint8Array) => {
    version += 1;
    objects.set(key, { bytes, etag: `"v${version}"` });
  };
  const send = async (command: GetObjectCommand | PutObjectCommand) => {
    if (command instanceof GetObjectCommand) {
      const key = command.input.Key!;
      const stored = objects.get(key);
      if (stored === undefined) {
        throw new NoSuchKey({ message: "missing", $metadata: { httpStatusCode: 404 } });
      }
      return {
        ETag: stored.etag,
        Body: { transformToByteArray: async () => stored.bytes },
      };
    }
    const key = command.input.Key!;
    hooks.beforePut?.(key);
    const current = objects.get(key);
    if (command.input.IfNoneMatch === "*" && current !== undefined) throw preconditionFailed();
    if (command.input.IfMatch !== undefined && current?.etag !== command.input.IfMatch) {
      throw preconditionFailed();
    }
    write(key, command.input.Body as Uint8Array);
    return {};
  };
  return { objects, write, client: { send } as unknown as S3Client };
};

describe("R2 append", () => {
  it("creates the object when absent and appends in order", async () => {
    const bucket = makeFakeBucket();
    const store = makeObjectStore(bucket.client, "bucket");
    await Effect.runPromise(store.append("sessions/a.jsonl", encode("one\n")));
    await Effect.runPromise(store.append("sessions/a.jsonl", encode("two\n")));
    expect(decode(bucket.objects.get("sessions/a.jsonl")!.bytes)).toBe("one\ntwo\n");
  });

  it("retries on a concurrent write instead of losing it", async () => {
    let interfered = false;
    const bucket = makeFakeBucket({
      beforePut: (key) => {
        if (interfered) return;
        interfered = true;
        bucket.write(key, encode("one\nintruder\n"));
      },
    });
    const store = makeObjectStore(bucket.client, "bucket");
    bucket.write("sessions/a.jsonl", encode("one\n"));
    await Effect.runPromise(store.append("sessions/a.jsonl", encode("two\n")));
    expect(decode(bucket.objects.get("sessions/a.jsonl")!.bytes)).toBe("one\nintruder\ntwo\n");
  });

  it("fails with a backend error once the retry budget is exhausted", async () => {
    const bucket = makeFakeBucket({
      beforePut: (key) => bucket.write(key, encode("moved\n")),
    });
    const store = makeObjectStore(bucket.client, "bucket");
    const result = await Effect.runPromise(
      Effect.result(store.append("sessions/a.jsonl", encode("two\n"))),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("StorageBackendError");
      expect(result.failure.errorType).toBe("AppendConflict");
    }
  });
});
