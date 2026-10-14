import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit, Result } from "effect";
import { expect } from "vitest";

import { openLocalConditionalObjectStore } from "../../src/storage/local-conditional-object-store.ts";
import type { ConditionalObjectStore } from "../../src/storage/object-store.ts";
import { makeObjectStore } from "../../src/storage/r2-object-store.ts";
import { makeFakeBucket } from "./fake-r2-bucket.ts";

export const backends = ["local", "r2"] as const;

export const expectBytes = (actual: Uint8Array, expected: Uint8Array) =>
  expect([...actual]).toEqual([...expected]);

export const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "gm-history-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
);

export const withObjects = <Value, Error>(
  backend: (typeof backends)[number],
  use: (objects: ConditionalObjectStore) => Effect.Effect<Value, Error>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        if (backend === "local") {
          const directory = yield* temporaryDirectory;
          return yield* use(yield* openLocalConditionalObjectStore(directory));
        }
        const bucket = yield* Effect.acquireRelease(
          Effect.sync(() => makeFakeBucket()),
          (bucket) => Effect.sync(() => bucket.client.destroy()),
        );
        return yield* use(makeObjectStore(bucket.client, "bucket"));
      }),
    ),
  );

export const expectFailure = <Value, Error, Services>(
  effect: Effect.Effect<Value, Error, Services>,
  tag: string,
) =>
  Effect.gen(function* () {
    expect(failure(yield* Effect.exit(effect))).toMatchObject({ _tag: tag });
  });

export const failure = <Value, Error>(exit: Exit.Exit<Value, Error>): Error => {
  expect(exit._tag).toBe("Failure");
  if (Exit.isSuccess(exit)) throw new Error("Expected failure");
  const error = Cause.findError(exit.cause);
  expect(error._tag).toBe("Success");
  if (Result.isFailure(error)) throw new Error("Expected a typed failure, not a defect");
  return error.success;
};
