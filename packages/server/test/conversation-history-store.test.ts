import { Deferred, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { makeHistoryStore } from "../src/conversation-history/store.ts";
import type { HistoryWrite } from "../src/conversation-history/schema.ts";
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
import { backends, expectFailure, failure, withObjects } from "./fixtures/history-storage.ts";

const address = { vault_id: vaultId, session_id: sessionId };
const key = `vaults/${vaultId}/sessions/${sessionId}.jsonl`;
const initial = () => [header(), attempt()];

for (const backend of backends)
  describe(`${backend} history/CAS integration`, () => {
    it.each(["identical", "distinct", "conflicting"] as const)(
      "observes %s competing batches once, without another PUT",
      (kind) =>
        withObjects(backend, (objects) =>
          Effect.gen(function* () {
            const store = makeHistoryStore(objects);
            if (kind !== "identical")
              yield* store.commit(
                address,
                kind === "distinct" ? [...initial(), settlement()] : initial(),
              );
            const ready = yield* Deferred.make<void>();
            let reads = 0;
            let puts = 0;
            const racing = makeHistoryStore({
              ...objects,
              getVersioned: (key) =>
                Effect.gen(function* () {
                  const snapshot = yield* Effect.exit(objects.getVersioned(key));
                  if (++reads === 2) yield* Deferred.succeed(ready, undefined);
                  yield* Deferred.await(ready);
                  if (Exit.isFailure(snapshot)) return yield* Effect.failCause(snapshot.cause);
                  return snapshot.value;
                }),
              putIfVersion: (...args) => {
                puts += 1;
                return objects.putIfVersion(...args);
              },
            });
            const batches: readonly (readonly HistoryWrite[])[] =
              kind === "identical"
                ? [initial(), initial()]
                : kind === "conflicting"
                  ? [[settlement()], [settlement({ answer: "Conflicting answer" })]]
                  : [102, 103].map((id) => [
                      attempt({
                        reply_id: uuid(id),
                        exchange_id: uuid(id + 100),
                        parent_reply_id: replyId,
                      }),
                    ]);
            const results = yield* Effect.all(
              batches.map((batch) => Effect.exit(racing.commit(address, batch))),
              { concurrency: 2 },
            );
            expect(puts).toBe(2);
            if (kind === "identical") {
              expect(results.every(Exit.isSuccess)).toBe(true);
              expect(
                results.filter((result) => Exit.isSuccess(result) && result.value.written),
              ).toHaveLength(1);
              expect((yield* store.read(address))!.history.revision.last_seq).toBe(2);
            } else {
              expect(results.filter(Exit.isSuccess)).toHaveLength(1);
              const loser = results.findIndex(Exit.isFailure);
              expect(failure(results[loser])._tag).toBe("ObjectVersionConflict");
              const saved = yield* objects.getVersioned(key);
              if (kind === "conflicting") {
                yield* expectFailure(store.commit(address, batches[loser]), "HistoryConflict");
                expect(yield* objects.getVersioned(key)).toEqual(saved);
              } else {
                yield* store.commit(address, batches[loser]);
                const history = (yield* store.read(address))!.history;
                expect(history.revision.last_seq).toBe(5);
                expect(
                  history.turns.flatMap((turn) =>
                    turn.attempts.map((attempt) => attempt.accepted.reply_id),
                  ),
                ).toEqual(expect.arrayContaining([replyId, uuid(102), uuid(103)]));
              }
            }
          }),
        ),
    );

    it.each(["malformed", "missing", "shortened"] as const)(
      "refuses reads and writes over %s acknowledged history without repair",
      (damage) =>
        withObjects(backend, (objects) =>
          Effect.gen(function* () {
            const store = makeHistoryStore(objects);
            const committed = yield* store.commit(address, [...initial(), settlement()]);
            const target = damage === "missing" ? { ...address, vault_id: uuid(999) } : address;
            const current = yield* objects.getVersioned(key);
            if (damage !== "missing")
              yield* objects.putIfVersion(
                key,
                current.version,
                damage === "shortened"
                  ? historyBytes(initial())
                  : new TextEncoder().encode("{ damaged history\n"),
              );
            const before = yield* objects.getVersioned(key);
            for (const operation of [
              store.read(target, committed.history.revision).pipe(Effect.asVoid),
              store.commit(target, initial(), committed.history.revision).pipe(Effect.asVoid),
            ])
              expect(failure(yield* Effect.exit(operation))).toMatchObject({
                _tag: "HistoryInvalid",
                reason: damage === "malformed" ? "invalid_json" : "history_receipt",
              });
            expect(yield* objects.getVersioned(key)).toEqual(before);
            if (damage === "missing") expect(yield* store.read(target)).toBeNull();
          }),
        ),
    );
  });

it("recognizes a committed conditional PUT after the SDK retries its lost acknowledgment", async () => {
  let mutations = 0;
  const bucket = makeFakeBucket({
    maxAttempts: 2,
    afterPut: () => {
      mutations += 1;
      throw Object.assign(new Error("Connection lost after commit"), { code: "ECONNRESET" });
    },
  });
  const store = makeHistoryStore(makeObjectStore(bucket.client, "bucket"));
  const recovered = await Effect.runPromise(store.commit(address, initial()));
  expect(recovered.written).toBe(false);
  expect(mutations).toBe(1);
  expect(bucket.requests.filter((request) => request.method === "PUT")).toHaveLength(2);
  expect(recovered.history.revision.last_seq).toBe(2);
  expect((await Effect.runPromise(store.commit(address, initial()))).written).toBe(false);
  expect(bucket.requests.filter((request) => request.method === "PUT")).toHaveLength(2);
});
