import { Database, replies, sessions } from "@great-minds/database";
import { and, eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { HistorySettlementWrite } from "../src/conversation-history/schema.ts";
import {
  makeReplySettlement,
  type ReplySettlementResult,
} from "../src/conversation-history/settlement.ts";
import type { HistoryStoreShape } from "../src/conversation-history/store.ts";
import { ObjectVersionConflict, storageBackendError } from "../src/storage/object-store.ts";
import { attempt, settlement, timestamp, uuid } from "./fixtures/conversation-history.ts";
import { failure } from "./fixtures/history-storage.ts";
import { completion, withSettlement } from "./fixtures/reply-settlement.ts";

const interruption = (status: "stopped" | "failed"): ReplySettlementResult => ({
  status,
  code: "generation_failed",
  message: "Generation failed",
  context_messages: completion().context_messages,
  generation: completion().generation,
});

const expectDefect = <Value, Error>(exit: Exit.Exit<Value, Error>, defect: unknown) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect);
};

const decodePayload = Schema.decodeUnknownSync(HistorySettlementWrite);

describe("durable reply settlement", () => {
  it.each(["completed", "stopped", "failed"] as const)(
    "freezes and publishes a %s result through the same path",
    (status) =>
      withSettlement((f) =>
        Effect.gen(function* () {
          const result = status === "completed" ? completion() : interruption(status);
          expect(yield* f.finalizer.begin(f.replyId, result)).toBe(true);
          const frozen = yield* f.reply();
          const payload = decodePayload(frozen.settlement);
          expect(frozen.status).toBe("settling");
          expect(frozen.version).toBe(1);
          expect(frozen.activeGenerationStep).toBe(1);
          expect(payload.reply_id).toBe(f.replyId);
          expect(payload.settled_at).toBe(timestamp);
          expect(payload.outcome.status).toBe(status);
          expect(payload.answer).toBe(
            status === "completed" ? completion().answer : f.progress.answer,
          );
          expect(payload.sources).toEqual(completion().sources);
          expect((yield* f.histories.read(f.address))?.history.revision.last_seq).toBe(2);
          expect((yield* f.session()).historySeq).toBe(2);

          expect(yield* f.finalizer.publish(f.replyId)).toBe(true);
          const terminal = yield* f.reply();
          const history = (yield* f.histories.read(f.address))!.history;
          const session = yield* f.session();
          expect(history.records[2]).toEqual({ ...payload, seq: 3 });
          expect(terminal).toMatchObject({
            status,
            answer: payload.answer,
            sources: payload.sources,
            error: status === "failed" ? "Generation failed" : null,
            version: 2,
            settlement: null,
            activeGenerationStep: null,
            activeGenerationKind: null,
            activeGenerationKey: null,
          });
          expect(session.historySeq).toBe(history.revision.last_seq);
          expect(session.historySha256).toBe(history.revision.sha256);
        }),
      ),
  );

  it.each(["completed", "stopped", "failed"] as const)(
    "restores recorded %s without overwriting history or honoring a later stop",
    (status) =>
      withSettlement((f) =>
        Effect.gen(function* () {
          yield* f.finalizer.begin(
            f.replyId,
            status === "completed" ? completion() : interruption(status),
          );
          yield* f.finalizer.publish(f.replyId);
          const original = yield* f.reply();
          const bytes = yield* f.objects.getVersioned(f.key);
          yield* f.db.query((d) =>
            d
              .update(replies)
              .set({
                status: "running",
                answer: "Stale projection",
                sources: [],
                stopRequested: true,
              })
              .where(eq(replies.id, f.replyId)),
          );
          yield* f.finalizer.restoreRecorded(f.replyId);
          const restored = yield* f.reply();
          expect(restored).toMatchObject({
            status,
            answer: original.answer,
            sources: original.sources,
            error: original.error,
            settlement: null,
            activeGenerationStep: null,
            version: original.version + 1,
          });
          yield* f.finalizer.restoreRecorded(f.replyId);
          expect(yield* f.reply()).toEqual(restored);
          expect(yield* f.objects.getVersioned(f.key)).toEqual(bytes);
        }),
      ),
  );

  it("acknowledges an already-recorded terminal result rather than freezing another result", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        const payload = settlement({ reply_id: f.replyId });
        const saved = yield* f.histories.commit(f.address, [payload], f.admission.history.revision);
        yield* f.finalizer.restoreRecorded(f.replyId);
        expect(yield* f.reply()).toMatchObject({
          status: "completed",
          answer: payload.answer,
          version: 1,
        });
        expect(yield* f.session()).toMatchObject({
          historySeq: saved.history.revision.last_seq,
          historySha256: saved.history.revision.sha256,
        });
        expect(yield* f.finalizer.begin(f.replyId, interruption("stopped"))).toBe(false);
      }),
    ));

  it("leaves an admitted but unsettled operation unchanged", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        const original = yield* f.reply();
        yield* f.finalizer.restoreRecorded(f.replyId);
        expect(yield* f.reply()).toEqual(original);
      }),
    ));

  it("refuses a stale restoration read after another receipt has advanced", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        const recorded = yield* f.histories.commit(
          f.address,
          [settlement({ reply_id: f.replyId })],
          f.admission.history.revision,
        );
        const newer = [
          attempt({ reply_id: uuid(41), exchange_id: uuid(42), parent_reply_id: f.replyId }),
          settlement({ reply_id: uuid(41) }),
        ];
        const histories = {
          ...f.histories,
          read: (address, receipt) =>
            Effect.gen(function* () {
              const original = yield* f.histories.read(address, receipt);
              const next = yield* f.histories
                .commit(address, newer, recorded.history.revision)
                .pipe(Effect.orDie);
              yield* f.db.query((d) =>
                d
                  .update(sessions)
                  .set({
                    historySeq: next.history.revision.last_seq,
                    historySha256: next.history.revision.sha256,
                  })
                  .where(
                    and(eq(sessions.id, f.address.session_id), eq(sessions.vaultId, f.vaultId)),
                  ),
              );
              return original;
            }),
        } satisfies HistoryStoreShape;
        const original = yield* f.reply();
        expect(
          failure(
            yield* Effect.exit(
              makeReplySettlement(f.db, histories, f.clock).restoreRecorded(f.replyId),
            ),
          ),
        ).toMatchObject({ _tag: "HistoryInvalid", reason: "history_receipt" });
        expect(yield* f.reply()).toEqual(original);
        expect((yield* f.session()).historySeq).toBe(5);
        yield* f.finalizer.restoreRecorded(f.replyId);
        expect((yield* f.reply()).status).toBe("completed");
        expect((yield* f.session()).historySeq).toBe(5);
      }),
    ));

  it("retains an external-outcome-unknown failure and committed partial output", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        yield* f.finalizer.begin(f.replyId, {
          status: "failed",
          code: "external_outcome_unknown",
          message: "The external call cannot safely be repeated",
          generation: null,
          context_messages: null,
        });
        yield* f.finalizer.publish(f.replyId);
        expect((yield* f.histories.read(f.address))!.history.records[2]).toMatchObject({
          outcome: { status: "failed", code: "external_outcome_unknown" },
          answer: f.progress.answer,
          sources: completion().sources,
          context_messages: null,
          generation: null,
        });
      }),
    ));

  it("does not replace the frozen result or timestamp on redelivery", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        yield* f.finalizer.begin(f.replyId, completion());
        const frozen = yield* f.reply();
        f.setTime(new Date("2026-10-11T12:00:00.000Z"));
        const restarted = makeReplySettlement(f.db, f.histories, f.clock);
        expect(yield* restarted.begin(f.replyId, interruption("failed"))).toBe(true);
        expect(yield* f.reply()).toEqual(frozen);
        yield* restarted.publish(f.replyId);
        const terminal = yield* f.reply();
        const bytes = yield* f.objects.getVersioned(f.key);
        expect(yield* restarted.begin(f.replyId, interruption("stopped"))).toBe(false);
        expect(yield* restarted.publish(f.replyId)).toBe(false);
        expect(yield* f.reply()).toEqual(terminal);
        expect(yield* f.objects.getVersioned(f.key)).toEqual(bytes);
        expect((yield* f.histories.read(f.address))!.history.records[2]).toMatchObject({
          settled_at: timestamp,
          outcome: { status: "completed" },
          answer: completion().answer,
        });
      }),
    ));

  it("serializes competing result freezes without mixing their payloads", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          [
            f.finalizer.begin(f.replyId, completion()),
            f.finalizer.begin(f.replyId, interruption("failed")),
          ],
          { concurrency: 2 },
        );
        expect(results).toEqual([true, true]);
        const frozen = yield* f.reply();
        const payload = decodePayload(frozen.settlement);
        expect(frozen.version).toBe(1);
        expect(payload.answer).toBe(
          payload.outcome.status === "completed" ? completion().answer : f.progress.answer,
        );
        expect(["completed", "failed"]).toContain(payload.outcome.status);
        yield* f.finalizer.publish(f.replyId);
        expect((yield* f.histories.read(f.address))!.history.records[2]).toEqual({
          ...payload,
          seq: 3,
        });
      }),
    ));

  it("lets a committed stop win before the result is frozen", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        yield* f.db.query((client) =>
          client.update(replies).set({ stopRequested: true }).where(eq(replies.id, f.replyId)),
        );
        const result = completion();
        yield* f.finalizer.begin(f.replyId, {
          ...result,
          context_messages: [
            { role: "user", content: "Question" },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "pending-tool",
                  type: "function",
                  function: { name: "read_document", arguments: "{}" },
                },
              ],
            },
          ],
        });
        yield* f.finalizer.publish(f.replyId);
        expect((yield* f.histories.read(f.address))!.history.records[2]).toMatchObject({
          outcome: { status: "stopped" },
          answer: f.progress.answer,
          context_messages: [
            { role: "user", content: "Question" },
            { role: "assistant", content: "", tool_calls: expect.any(Array) },
            {
              role: "tool",
              tool_call_id: "pending-tool",
              content: "Tool call cancelled because the user stopped the response.",
            },
            { role: "assistant", content: f.progress.answer },
          ],
        });
      }),
    ));

  it("fences running-only stop and progress updates after the result is frozen", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        yield* f.finalizer.begin(f.replyId, completion());
        const frozen = yield* f.reply();
        const updated = yield* f.db.query((client) =>
          client
            .update(replies)
            .set({
              stopRequested: true,
              answer: "Late token",
              version: sql`${replies.version} + 1`,
            })
            .where(and(eq(replies.id, f.replyId), eq(replies.status, "running")))
            .returning(),
        );
        expect(updated).toEqual([]);
        expect(yield* f.reply()).toEqual(frozen);
        yield* f.finalizer.publish(f.replyId);
        expect((yield* f.reply()).status).toBe("completed");
      }),
    ));

  it("publishes the frozen payload rather than rebuilding it from live fields", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        yield* f.finalizer.begin(f.replyId, completion());
        yield* f.db.query((client) =>
          client
            .update(replies)
            .set({
              answer: "Incorrect late progress",
              sources: [],
              stopRequested: true,
            })
            .where(eq(replies.id, f.replyId)),
        );
        yield* f.finalizer.publish(f.replyId);
        expect(yield* f.reply()).toMatchObject({
          status: "completed",
          answer: completion().answer,
          sources: completion().sources,
        });
      }),
    ));

  it("leaves storage failures pending and lets a new coordinator finish the exact result", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        let attempts = 0;
        const unavailable: HistoryStoreShape = {
          ...f.histories,
          commit: () =>
            Effect.gen(function* () {
              attempts += 1;
              return yield* storageBackendError("write", f.key, new Error("Storage unavailable"));
            }),
        };
        const failing = makeReplySettlement(f.db, unavailable, f.clock);
        yield* failing.begin(f.replyId, completion());
        const frozen = yield* f.reply();
        expect(failure(yield* Effect.exit(failing.publish(f.replyId)))).toMatchObject({
          _tag: "StorageBackendError",
        });
        expect(attempts).toBe(1);
        expect(yield* f.reply()).toEqual(frozen);
        expect((yield* f.histories.read(f.address))!.history.revision.last_seq).toBe(2);
        f.setTime(new Date("2026-10-11T12:00:00.000Z"));
        const restarted = makeReplySettlement(f.db, f.histories, f.clock);
        yield* restarted.publish(f.replyId);
        expect((yield* f.histories.read(f.address))!.history.records[2]).toEqual({
          ...decodePayload(frozen.settlement),
          seq: 3,
        });
      }),
    ));

  it("returns a CAS conflict without an inline retry or a changed outcome", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        let attempts = 0;
        const contested: HistoryStoreShape = {
          ...f.histories,
          commit: () =>
            Effect.gen(function* () {
              attempts += 1;
              return yield* new ObjectVersionConflict({ key: f.key });
            }),
        };
        yield* f.finalizer.begin(f.replyId, completion());
        const frozen = yield* f.reply();
        expect(
          failure(
            yield* Effect.exit(makeReplySettlement(f.db, contested, f.clock).publish(f.replyId)),
          ),
        ).toMatchObject({
          _tag: "ObjectVersionConflict",
        });
        expect(attempts).toBe(1);
        expect(yield* f.reply()).toEqual(frozen);
        yield* f.finalizer.publish(f.replyId);
        expect((yield* f.reply()).status).toBe("completed");
      }),
    ));

  it("recognizes a committed history write after its acknowledgement is lost", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        let physicalWrites = 0;
        const ambiguous: HistoryStoreShape = {
          ...f.histories,
          commit: (address, writes, receipt) =>
            Effect.gen(function* () {
              const saved = yield* f.histories.commit(address, writes, receipt);
              if (saved.written) {
                physicalWrites += 1;
                return yield* storageBackendError(
                  "write",
                  f.key,
                  new Error("Acknowledgement lost"),
                );
              }
              return saved;
            }),
        };
        const finalizer = makeReplySettlement(f.db, ambiguous, f.clock);
        yield* finalizer.begin(f.replyId, completion());
        const frozen = yield* f.reply();
        expect(failure(yield* Effect.exit(finalizer.publish(f.replyId)))).toMatchObject({
          _tag: "StorageBackendError",
        });
        expect(yield* f.reply()).toEqual(frozen);
        expect((yield* f.session()).historySeq).toBe(2);
        const saved = yield* f.objects.getVersioned(f.key);
        expect((yield* f.histories.read(f.address))!.history.revision.last_seq).toBe(3);
        expect(yield* finalizer.publish(f.replyId)).toBe(true);
        expect(physicalWrites).toBe(1);
        expect(yield* f.objects.getVersioned(f.key)).toEqual(saved);
        expect((yield* f.session()).historySeq).toBe(3);
      }),
    ));

  it("repairs a DB projection transaction rolled back after history was saved", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        yield* f.finalizer.begin(f.replyId, completion());
        const frozen = yield* f.reply();
        const fault = new Error("Projection transaction interrupted");
        const interrupted: Database["Service"] = {
          ...f.db,
          transaction: (run) =>
            f.db.transaction((tx) =>
              Effect.gen(function* () {
                yield* run(tx);
                return yield* Effect.die(fault);
              }),
            ),
        };
        expectDefect(
          yield* Effect.exit(
            makeReplySettlement(interrupted, f.histories, f.clock).publish(f.replyId),
          ),
          fault,
        );
        expect(yield* f.reply()).toEqual(frozen);
        expect((yield* f.session()).historySeq).toBe(2);
        const saved = yield* f.objects.getVersioned(f.key);
        expect((yield* f.histories.read(f.address))!.history.revision.last_seq).toBe(3);
        yield* makeReplySettlement(f.db, f.histories, f.clock).publish(f.replyId);
        expect(yield* f.objects.getVersioned(f.key)).toEqual(saved);
        expect((yield* f.reply()).version).toBe(2);
        expect((yield* f.session()).historySeq).toBe(3);
      }),
    ));

  it("does not repeat DB publication after a committed transaction loses its acknowledgement", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        yield* f.finalizer.begin(f.replyId, completion());
        const fault = new Error("DB acknowledgement lost");
        const ambiguous: Database["Service"] = {
          ...f.db,
          transaction: (run) =>
            Effect.gen(function* () {
              yield* f.db.transaction(run);
              return yield* Effect.die(fault);
            }),
        };
        expectDefect(
          yield* Effect.exit(
            makeReplySettlement(ambiguous, f.histories, f.clock).publish(f.replyId),
          ),
          fault,
        );
        const terminal = yield* f.reply();
        const saved = yield* f.objects.getVersioned(f.key);
        expect(terminal.status).toBe("completed");
        expect(terminal.settlement).toBeNull();
        expect(yield* f.finalizer.publish(f.replyId)).toBe(false);
        expect(yield* f.reply()).toEqual(terminal);
        expect(yield* f.objects.getVersioned(f.key)).toEqual(saved);
      }),
    ));

  it("rolls back an interrupted freeze without creating a history settlement", () =>
    withSettlement((fixture) =>
      Effect.gen(function* () {
        const original = yield* fixture.reply();
        const saved = yield* fixture.objects.getVersioned(fixture.key);
        const fault = new Error("Freeze transaction interrupted");
        const interrupted: Database["Service"] = {
          ...fixture.db,
          transaction: (run) =>
            fixture.db.transaction((tx) =>
              Effect.gen(function* () {
                yield* run(tx);
                return yield* Effect.die(fault);
              }),
            ),
        };
        expectDefect(
          yield* Effect.exit(
            makeReplySettlement(interrupted, fixture.histories, fixture.clock).begin(
              fixture.replyId,
              completion(),
            ),
          ),
          fault,
        );
        expect(yield* fixture.reply()).toEqual(original);
        expect(yield* fixture.objects.getVersioned(fixture.key)).toEqual(saved);
        yield* fixture.finalizer.begin(fixture.replyId, completion());
        yield* fixture.finalizer.publish(fixture.replyId);
        expect((yield* fixture.reply()).version).toBe(2);
      }),
    ));

  it("keeps an acknowledged freeze when the DB acknowledgement is lost", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        const fault = new Error("Freeze acknowledgement lost");
        const ambiguous: Database["Service"] = {
          ...f.db,
          transaction: (run) =>
            Effect.gen(function* () {
              yield* f.db.transaction(run);
              return yield* Effect.die(fault);
            }),
        };
        expectDefect(
          yield* Effect.exit(
            makeReplySettlement(ambiguous, f.histories, f.clock).begin(f.replyId, completion()),
          ),
          fault,
        );
        const frozen = yield* f.reply();
        expect(frozen.status).toBe("settling");
        yield* f.finalizer.begin(f.replyId, interruption("failed"));
        expect(yield* f.reply()).toEqual(frozen);
        yield* f.finalizer.publish(f.replyId);
        expect((yield* f.reply()).status).toBe("completed");
      }),
    ));

  it("refuses settlement before a session has a confirmed history prefix", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        yield* f.db.query((client) =>
          client
            .update(sessions)
            .set({ historySeq: null, historySha256: null })
            .where(eq(sessions.vaultId, f.vaultId)),
        );
        expect(
          failure(yield* Effect.exit(f.finalizer.begin(f.replyId, completion()))),
        ).toMatchObject({
          _tag: "ReplySettlementInvalid",
          reason: "history_receipt",
        });
        expect(yield* f.reply()).toMatchObject({ status: "running", settlement: null, version: 0 });
      }),
    ));

  it("does not append over history that disagrees with the session receipt", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        yield* f.finalizer.begin(f.replyId, completion());
        const frozen = yield* f.reply();
        const saved = yield* f.objects.getVersioned(f.key);
        yield* f.db.query((client) =>
          client.execute(sql`
      update sessions set history_sha256 = ${"0".repeat(64)} where vault_id = ${f.vaultId}
    `),
        );
        expect(failure(yield* Effect.exit(f.finalizer.publish(f.replyId)))).toMatchObject({
          _tag: "HistoryInvalid",
          reason: "history_receipt",
        });
        expect(yield* f.reply()).toEqual(frozen);
        expect(yield* f.objects.getVersioned(f.key)).toEqual(saved);
      }),
    ));

  it("does not replace an incompatible earlier receipt while committing the DB projection", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        yield* f.finalizer.begin(f.replyId, completion());
        const changedReceipt: HistoryStoreShape = {
          ...f.histories,
          commit: (address, writes, receipt) =>
            Effect.gen(function* () {
              const saved = yield* f.histories.commit(address, writes, receipt);
              yield* f.db.query((client) =>
                client.execute(sql`
          update sessions set history_sha256 = ${"0".repeat(64)} where vault_id = ${f.vaultId}
        `),
              );
              return saved;
            }),
        };
        expect(
          failure(
            yield* Effect.exit(
              makeReplySettlement(f.db, changedReceipt, f.clock).publish(f.replyId),
            ),
          ),
        ).toMatchObject({
          _tag: "HistoryInvalid",
          reason: "history_receipt",
        });
        expect((yield* f.reply()).status).toBe("settling");
        expect((yield* f.session()).historySha256).toBe("0".repeat(64));
        expect((yield* f.histories.read(f.address))!.history.revision.last_seq).toBe(3);
      }),
    ));

  it("does not move a session receipt backwards when it advances before DB publication", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        yield* f.finalizer.begin(f.replyId, completion());
        const advancing: HistoryStoreShape = {
          ...f.histories,
          commit: (address, writes, receipt) =>
            Effect.gen(function* () {
              const saved = yield* f.histories.commit(address, writes, receipt);
              const advanced = yield* f.histories.commit(address, [
                attempt({
                  reply_id: uuid(500),
                  exchange_id: uuid(501),
                  parent_reply_id: f.replyId,
                }),
              ]);
              yield* f.db.query((client) =>
                client
                  .update(sessions)
                  .set({
                    historySeq: advanced.history.revision.last_seq,
                    historySha256: advanced.history.revision.sha256,
                  })
                  .where(eq(sessions.vaultId, f.vaultId)),
              );
              return saved;
            }),
        };
        expect(
          failure(
            yield* Effect.exit(makeReplySettlement(f.db, advancing, f.clock).publish(f.replyId)),
          ),
        ).toMatchObject({
          _tag: "HistoryInvalid",
          reason: "history_receipt",
        });
        expect((yield* f.reply()).status).toBe("settling");
        expect((yield* f.session()).historySeq).toBe(4);
        yield* f.finalizer.publish(f.replyId);
        expect((yield* f.reply()).status).toBe("completed");
        expect((yield* f.session()).historySeq).toBe(4);
      }),
    ));

  it.each(["generation", "context_messages", "settled_at"] as const)(
    "rejects a stored native completion without %s",
    (field) =>
      withSettlement((f) =>
        Effect.gen(function* () {
          yield* f.finalizer.begin(f.replyId, completion());
          const payload = decodePayload((yield* f.reply()).settlement);
          yield* f.db.query((client) =>
            client
              .update(replies)
              .set({ settlement: { ...payload, [field]: null } })
              .where(eq(replies.id, f.replyId)),
          );
          const saved = yield* f.objects.getVersioned(f.key);
          expect(failure(yield* Effect.exit(f.finalizer.publish(f.replyId)))).toMatchObject({
            _tag: "ReplySettlementInvalid",
            reason: "settlement_payload",
          });
          expect((yield* f.reply()).status).toBe("settling");
          expect(yield* f.objects.getVersioned(f.key)).toEqual(saved);
        }),
      ),
  );

  it("rejects a stored settlement for a different reply identity", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        yield* f.finalizer.begin(f.replyId, completion());
        const payload = decodePayload((yield* f.reply()).settlement);
        yield* f.db.query((client) =>
          client
            .update(replies)
            .set({ settlement: { ...payload, reply_id: uuid(999) } })
            .where(eq(replies.id, f.replyId)),
        );
        expect(failure(yield* Effect.exit(f.finalizer.publish(f.replyId)))).toMatchObject({
          _tag: "ReplySettlementInvalid",
          reason: "settlement_identity",
        });
        expect((yield* f.histories.read(f.address))!.history.revision.last_seq).toBe(2);
      }),
    ));

  it("preserves both sides of a conflicting saved settlement for diagnosis", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        yield* f.finalizer.begin(f.replyId, completion());
        const frozen = yield* f.reply();
        yield* f.histories.commit(f.address, [
          { ...decodePayload(frozen.settlement), answer: "Conflicting saved result" },
        ]);
        const saved = yield* f.objects.getVersioned(f.key);
        expect(failure(yield* Effect.exit(f.finalizer.publish(f.replyId)))).toMatchObject({
          _tag: "HistoryConflict",
        });
        expect(yield* f.reply()).toEqual(frozen);
        expect(yield* f.objects.getVersioned(f.key)).toEqual(saved);
      }),
    ));

  it("does nothing for absent replies or replies that are still generating", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        const original = yield* f.reply();
        expect(yield* f.finalizer.begin(uuid(999), completion())).toBe(false);
        expect(yield* f.finalizer.publish(uuid(999))).toBe(false);
        expect(yield* f.finalizer.publish(f.replyId)).toBe(false);
        expect(yield* f.reply()).toEqual(original);
        expect((yield* f.histories.read(f.address))!.history.revision.last_seq).toBe(2);
      }),
    ));
});

describe("reply settlement database invariants", () => {
  it.each([
    { name: "a sequence without a hash", seq: 2, hash: null },
    { name: "a hash without a sequence", seq: null, hash: "0".repeat(64) },
    { name: "a nonpositive sequence", seq: 0, hash: "0".repeat(64) },
    {
      name: "a sequence outside JavaScript's safe integer range",
      seq: Number.MAX_SAFE_INTEGER + 1,
      hash: "0".repeat(64),
    },
    { name: "a malformed SHA-256 value", seq: 2, hash: "z".repeat(64) },
  ])("rejects $name", ({ seq, hash }) =>
    withSettlement((f) =>
      Effect.gen(function* () {
        const original = yield* f.session();
        const exit = yield* Effect.exit(
          f.db.query((client) =>
            client.execute(sql`
      update sessions set history_seq = ${seq}, history_sha256 = ${hash} where vault_id = ${f.vaultId}
    `),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* f.session()).toEqual(original);
      }),
    ),
  );

  it.each([
    { status: "settling", settlement: null },
    { status: "running", settlement: {} },
    { status: "completed", settlement: {} },
  ] as const)("rejects an incompatible $status status and pending payload", (values) =>
    withSettlement((f) =>
      Effect.gen(function* () {
        const original = yield* f.reply();
        const exit = yield* Effect.exit(
          f.db.query((client) =>
            client.update(replies).set(values).where(eq(replies.id, f.replyId)),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* f.reply()).toEqual(original);
      }),
    ),
  );
});
