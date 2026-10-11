import { Deferred, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { makeHistoryStore } from "../src/conversation-history/store.ts";
import type { HistoryWrite } from "../src/conversation-history/schema.ts";
import { type ConditionalObjectStore, storageBackendError } from "../src/storage/object-store.ts";
import { makeObjectStore } from "../src/storage/r2-object-store.ts";
import {
  attempt,
  header,
  historyBytes,
  replyId,
  sessionId,
  settlement,
  uuid,
  vaultId,
} from "./fixtures/conversation-history.ts";
import { makeFakeBucket } from "./fixtures/fake-r2-bucket.ts";
import { backends, expectBytes, failure, withObjects } from "./fixtures/history-storage.ts";

const address = { vault_id: vaultId, session_id: sessionId };
const key = `vaults/${vaultId}/sessions/${sessionId}.jsonl`;
const initial = () => [header(), attempt()];

const withSimultaneousReads = (objects: ConditionalObjectStore) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    let reads = 0;
    return {
      ...objects,
      getVersioned: (key: string) =>
        Effect.gen(function* () {
          const snapshot = yield* Effect.exit(objects.getVersioned(key));
          reads += 1;
          if (reads === 2) yield* Deferred.succeed(ready, undefined);
          yield* Deferred.await(ready);
          if (Exit.isFailure(snapshot)) return yield* Effect.failCause(snapshot.cause);
          return snapshot.value;
        }),
    } satisfies ConditionalObjectStore;
  });

for (const backend of backends)
  describe(`${backend} conversation history store`, () => {
    it("creates the header and first attempt together at the existing session path", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const store = makeHistoryStore(objects);
          expect(yield* store.read(address)).toBeNull();
          const committed = yield* store.commit(address, initial());
          expect(committed.written).toBe(true);
          expectBytes(
            (yield* objects.getVersioned(key)).bytes,
            new TextEncoder().encode(committed.history.jsonl),
          );
          expect((yield* store.read(address))?.history.revision).toEqual(
            committed.history.revision,
          );
        }),
      ));

    it("does not write a header-only conversation", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const store = makeHistoryStore(objects);
          expect(failure(yield* Effect.exit(store.commit(address, [header()])))).toMatchObject({
            _tag: "HistoryInvalid",
            reason: "empty_history",
          });
          expect(yield* store.read(address)).toBeNull();
        }),
      ));

    it("replays acceptance and settlement without changing bytes or the backend version", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const store = makeHistoryStore(objects);
          yield* store.commit(address, [...initial(), settlement()]);
          const before = yield* objects.getVersioned(key);
          const replay = yield* store.commit(address, [...initial(), settlement()]);
          expect(replay.written).toBe(false);
          expect(replay.history.revision.last_seq).toBe(3);
          expect(yield* objects.getVersioned(key)).toEqual(before);
        }),
      ));

    it("rejects a conflicting terminal result without touching the original", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const store = makeHistoryStore(objects);
          yield* store.commit(address, [...initial(), settlement()]);
          const before = yield* objects.getVersioned(key);
          const conflict = yield* Effect.exit(
            store.commit(address, [settlement({ outcome: { status: "stopped" } })]),
          );
          expect(failure(conflict)).toMatchObject({ _tag: "HistoryConflict" });
          expect(yield* objects.getVersioned(key)).toEqual(before);
        }),
      ));

    it("leaves no file when the first storage write fails, and permits the same acceptance to finish later", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const unavailable = makeHistoryStore({
            ...objects,
            putIfVersion: (key) =>
              Effect.fail(storageBackendError("write", key, new Error("Unavailable"))),
          });
          expect(failure(yield* Effect.exit(unavailable.commit(address, initial())))).toMatchObject(
            { _tag: "StorageBackendError" },
          );
          const healthy = makeHistoryStore(objects);
          expect(yield* healthy.read(address)).toBeNull();
          expect((yield* healthy.commit(address, initial())).history.revision.last_seq).toBe(2);
        }),
      ));

    it.each(["acceptance", "settlement"] as const)(
      "recovers a lost %s acknowledgment without duplicating history",
      (phase) =>
        withObjects(backend, (objects) =>
          Effect.gen(function* () {
            const healthy = makeHistoryStore(objects);
            if (phase === "settlement") yield* healthy.commit(address, initial());
            let physicalWrites = 0;
            const lostAcknowledgment = makeHistoryStore({
              ...objects,
              putIfVersion: (key, version, bytes) =>
                Effect.gen(function* () {
                  physicalWrites += 1;
                  yield* objects.putIfVersion(key, version, bytes);
                  return yield* storageBackendError("write", key, new Error("Acknowledgment lost"));
                }),
            });
            const writes = phase === "acceptance" ? initial() : [settlement()];
            expect(
              failure(yield* Effect.exit(lostAcknowledgment.commit(address, writes))),
            ).toMatchObject({ _tag: "StorageBackendError" });
            const persisted = yield* objects.getVersioned(key);
            const replay = yield* lostAcknowledgment.commit(address, writes);
            expect(replay.written).toBe(false);
            expect(physicalWrites).toBe(1);
            expect(yield* objects.getVersioned(key)).toEqual(persisted);
            expect(replay.history.revision.last_seq).toBe(phase === "acceptance" ? 2 : 3);
          }),
        ),
    );

    it("requires a fresh read after competing appends and then preserves both additions", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const healthy = makeHistoryStore(objects);
          yield* healthy.commit(address, [...initial(), settlement()]);
          const racing = makeHistoryStore(yield* withSimultaneousReads(objects));
          const additions = [
            attempt({ reply_id: uuid(102), exchange_id: uuid(202), parent_reply_id: replyId }),
            attempt({ reply_id: uuid(103), exchange_id: uuid(203), parent_reply_id: replyId }),
          ];
          const results = yield* Effect.all(
            additions.map((addition) => Effect.exit(racing.commit(address, [addition]))),
            { concurrency: 2 },
          );
          expect(results.filter(Exit.isSuccess)).toHaveLength(1);
          const losing = results.findIndex(Exit.isFailure);
          expect(failure(results[losing])).toMatchObject({ _tag: "ObjectVersionConflict" });
          yield* healthy.commit(address, [additions[losing]]);
          const history = (yield* healthy.read(address))!.history;
          expect(history.revision.last_seq).toBe(5);
          expect(
            history.turns.flatMap((turn) =>
              turn.attempts.map((attempt) => attempt.accepted.reply_id),
            ),
          ).toEqual(expect.arrayContaining([replyId, uuid(102), uuid(103)]));
        }),
      ));

    it("turns a competing identical acceptance into a no-op on redelivery", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const racing = makeHistoryStore(yield* withSimultaneousReads(objects));
          const results = yield* Effect.all(
            [
              Effect.exit(racing.commit(address, initial())),
              Effect.exit(racing.commit(address, initial())),
            ],
            { concurrency: 2 },
          );
          expect(results.filter(Exit.isSuccess)).toHaveLength(1);
          expect(failure(results.find(Exit.isFailure)!)).toMatchObject({
            _tag: "ObjectVersionConflict",
          });
          const replay = yield* makeHistoryStore(objects).commit(address, initial());
          expect(replay.written).toBe(false);
          expect(replay.history.revision.last_seq).toBe(2);
        }),
      ));

    it("reports conflicting competing settlements after reading the winning version", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const healthy = makeHistoryStore(objects);
          yield* healthy.commit(address, initial());
          const racing = makeHistoryStore(yield* withSimultaneousReads(objects));
          const writes: readonly HistoryWrite[] = [
            settlement(),
            settlement({ outcome: { status: "stopped" } }),
          ];
          const results = yield* Effect.all(
            writes.map((write) => Effect.exit(racing.commit(address, [write]))),
            { concurrency: 2 },
          );
          expect(results.filter(Exit.isSuccess)).toHaveLength(1);
          const losing = results.findIndex(Exit.isFailure);
          expect(failure(results[losing])).toMatchObject({ _tag: "ObjectVersionConflict" });
          const original = yield* objects.getVersioned(key);
          expect(
            failure(yield* Effect.exit(healthy.commit(address, [writes[losing]]))),
          ).toMatchObject({ _tag: "HistoryConflict" });
          expect(yield* objects.getVersioned(key)).toEqual(original);
        }),
      ));

    it("does not repair or append over a malformed file", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const damaged = new TextEncoder().encode("{ damaged history\n");
          yield* objects.putIfVersion(key, null, damaged);
          const store = makeHistoryStore(objects);
          const original = yield* objects.getVersioned(key);
          expect(failure(yield* Effect.exit(store.read(address)))).toMatchObject({
            _tag: "HistoryInvalid",
          });
          expect(failure(yield* Effect.exit(store.commit(address, initial())))).toMatchObject({
            _tag: "HistoryInvalid",
          });
          expect(yield* objects.getVersioned(key)).toEqual(original);
        }),
      ));

    it("refuses to recreate missing acknowledged history during a commit", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const store = makeHistoryStore(objects);
          const committed = yield* store.commit(address, initial());
          const missing = { ...address, vault_id: uuid(999) };
          expect(
            failure(
              yield* Effect.exit(store.commit(missing, initial(), committed.history.revision)),
            ),
          ).toMatchObject({
            _tag: "HistoryInvalid",
            reason: "history_receipt",
          });
          expect(yield* store.read(missing)).toBeNull();
        }),
      ));

    it("refuses to append over a lost complete tail covered by a known receipt", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const store = makeHistoryStore(objects);
          const committed = yield* store.commit(address, [...initial(), settlement()]);
          const current = yield* objects.getVersioned(key);
          yield* objects.putIfVersion(key, current.version, historyBytes(initial()));
          const shortened = yield* objects.getVersioned(key);
          expect(
            failure(
              yield* Effect.exit(
                store.commit(
                  address,
                  [attempt({ reply_id: uuid(102), exchange_id: uuid(202) })],
                  committed.history.revision,
                ),
              ),
            ),
          ).toMatchObject({
            _tag: "HistoryInvalid",
            reason: "history_receipt",
          });
          expect(yield* objects.getVersioned(key)).toEqual(shortened);
        }),
      ));

    it("checks a known receipt even when the file is missing or an otherwise valid older prefix", () =>
      withObjects(backend, (objects) =>
        Effect.gen(function* () {
          const store = makeHistoryStore(objects);
          const committed = yield* store.commit(address, [...initial(), settlement()]);
          const current = yield* objects.getVersioned(key);
          yield* objects.putIfVersion(key, current.version, historyBytes(initial()));
          expect(
            failure(yield* Effect.exit(store.read(address, committed.history.revision))),
          ).toMatchObject({ _tag: "HistoryInvalid", reason: "history_receipt" });
          expect(
            failure(
              yield* Effect.exit(
                store.read({ ...address, vault_id: uuid(999) }, committed.history.revision),
              ),
            ),
          ).toMatchObject({ _tag: "HistoryInvalid", reason: "history_receipt" });
        }),
      ));
  });

describe("R2 acknowledgment loss through the SDK boundary", () => {
  it("does not submit a second physical write when the first PUT was committed before the connection failed", async () => {
    const bucket = makeFakeBucket({
      afterPut: () => {
        throw new Error("Connection lost after commit");
      },
    });
    const store = makeHistoryStore(makeObjectStore(bucket.client, "bucket"));
    const exit = await Effect.runPromise(Effect.exit(store.commit(address, initial())));
    expect(failure(exit)).toMatchObject({ _tag: "StorageBackendError" });
    const recovered = await Effect.runPromise(store.commit(address, initial()));
    expect(recovered.written).toBe(false);
    expect(bucket.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    expect(recovered.history.revision.last_seq).toBe(2);
  });
});
