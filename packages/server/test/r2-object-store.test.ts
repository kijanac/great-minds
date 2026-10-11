import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeObjectStore } from "../src/storage/r2-object-store.ts";
import { makeFakeBucket } from "./fixtures/fake-r2-bucket.ts";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

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
