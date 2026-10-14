import { FileFingerprint } from "@great-minds/domain";
import { sql } from "drizzle-orm";
import { Cause, Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { HistorySettlementWrite } from "../src/conversation-history/schema.ts";
import {
  makeReplySettlement,
  type ReplySettlementResult,
} from "../src/conversation-history/settlement.ts";
import type { HistoryStoreShape } from "../src/conversation-history/store.ts";
import { ObjectVersionConflict, storageBackendError } from "../src/storage/object-store.ts";
import {
  attempt,
  completion,
  settlement,
  timestamp,
  uuid,
} from "./fixtures/conversation-history.ts";
import { expectFailure, failure } from "./fixtures/history-storage.ts";
import { withSettlement } from "./fixtures/reply-settlement.ts";
import { failTransactions } from "./fixtures/transaction-failure.ts";

const interruption = (status: "stopped" | "failed"): ReplySettlementResult => ({
  status,
  code: "generation_failed",
  message: "Generation failed",
  context_messages: completion().context_messages,
  generation: completion().generation,
});
const decodePayload = Schema.decodeUnknownSync(HistorySettlementWrite);
const expectDefect = <Value, Error>(exit: Exit.Exit<Value, Error>, defect: unknown) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect);
};

describe("durable settlement", () => {
  it.each(["completed", "stopped", "failed", "unknown"] as const)(
    "freezes, publishes and restores %s exactly despite redelivery and late progress/Stop",
    (status) =>
      withSettlement((f) =>
        Effect.gen(function* () {
          const original = yield* f.reply();
          const result: ReplySettlementResult =
            status === "completed"
              ? completion()
              : status === "unknown"
                ? {
                    status: "failed",
                    code: "external_outcome_unknown",
                    message: "External outcome unknown",
                    generation: null,
                    context_messages: null,
                  }
                : interruption(status);
          expect(yield* f.finalizer.begin(f.replyId, result)).toBe(true);
          const frozen = yield* f.reply();
          const payload = decodePayload(frozen.settlement);
          expect(frozen).toMatchObject({
            status: "settling",
            version: original.version + 1,
            activeGenerationStep: 1,
          });
          expect(payload).toMatchObject({
            reply_id: f.replyId,
            settled_at: timestamp,
            outcome: { status: result.status },
            answer: status === "completed" ? completion().answer : f.progress.answer,
            sources: completion().sources,
          });
          if (status === "unknown")
            expect(payload).toMatchObject({
              outcome: { code: "external_outcome_unknown" },
              context_messages: null,
              generation: null,
            });
          expect((yield* f.histories.read(f.address))!.history.revision.last_seq).toBe(2);
          expect((yield* f.session()).historySeq).toBe(2);
          f.setTime(new Date("2026-10-11T12:00:00.000Z"));
          const restarted = makeReplySettlement(f.db, f.histories, f.clock);
          expect(yield* restarted.begin(f.replyId, interruption("failed"))).toBe(true);
          expect(yield* f.reply()).toEqual(frozen);
          yield* f.updateReply({ answer: "Late progress", sources: [], stopRequested: true });
          expect(yield* restarted.publish(f.replyId)).toBe(true);
          const terminal = yield* f.reply();
          const history = (yield* f.histories.read(f.address))!.history;
          expect(history.records[2]).toEqual({ ...payload, seq: 3 });
          expect(terminal).toMatchObject({
            status: result.status,
            answer: payload.answer,
            sources: payload.sources,
            error: result.status === "failed" ? result.message : null,
            version: frozen.version + 1,
            settlement: null,
            activeGenerationStep: null,
            activeGenerationKind: null,
            activeGenerationKey: null,
          });
          expect(yield* f.session()).toMatchObject({
            historySeq: 3,
            historySha256: history.revision.sha256,
          });
          const bytes = yield* f.objects.getVersioned(f.key);
          expect(yield* restarted.begin(f.replyId, interruption("stopped"))).toBe(false);
          expect(yield* restarted.publish(f.replyId)).toBe(false);
          expect(yield* f.reply()).toEqual(terminal);
          expect(yield* f.objects.getVersioned(f.key)).toEqual(bytes);
        }),
      ),
  );

  it("serializes competing freezes without mixing their payloads", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        expect(
          yield* Effect.all(
            [
              f.finalizer.begin(f.replyId, completion()),
              f.finalizer.begin(f.replyId, interruption("failed")),
            ],
            { concurrency: 2 },
          ),
        ).toEqual([true, true]);
        const frozen = yield* f.reply();
        const payload = decodePayload(frozen.settlement);
        expect(frozen.version).toBe(2);
        expect(["completed", "failed"]).toContain(payload.outcome.status);
        expect(payload.answer).toBe(
          payload.outcome.status === "completed" ? completion().answer : f.progress.answer,
        );
        yield* f.finalizer.publish(f.replyId);
        expect((yield* f.histories.read(f.address))!.history.records[2]).toEqual({
          ...payload,
          seq: 3,
        });
      }),
    ));

  it.each(["completed", "failed"] as const)(
    "lets committed Stop win before freezing %s and closes pending tool calls",
    (status) =>
      withSettlement((f) =>
        Effect.gen(function* () {
          yield* f.updateReply({ stopRequested: true });
          yield* f.finalizer.begin(f.replyId, {
            ...(status === "completed" ? completion() : interruption(status)),
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
          expect(yield* f.reply()).toMatchObject({
            status: "stopped",
            error: null,
            answer: f.progress.answer,
          });
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
      ),
  );

  it.each(["unavailable", "conflict", "lost-ack"] as const)(
    "retains an exact publication obligation after %s without inline retries",
    (fault) =>
      withSettlement((f) =>
        Effect.gen(function* () {
          let failing = true;
          let calls = 0;
          let writes = 0;
          const histories: HistoryStoreShape = {
            ...f.histories,
            commit: (...args) =>
              Effect.gen(function* () {
                calls += 1;
                if (!failing || fault === "lost-ack") {
                  const saved = yield* f.histories.commit(...args);
                  if (saved.written) writes += 1;
                  if (!failing) return saved;
                }
                return yield* fault === "conflict"
                  ? new ObjectVersionConflict({ key: f.key })
                  : storageBackendError("write", f.key, new Error(fault));
              }),
          };
          const finalizer = makeReplySettlement(f.db, histories, f.clock);
          yield* finalizer.begin(f.replyId, completion());
          const frozen = yield* f.reply();
          yield* expectFailure(
            finalizer.publish(f.replyId),
            fault === "conflict" ? "ObjectVersionConflict" : "StorageBackendError",
          );
          expect(calls).toBe(1);
          expect(yield* f.reply()).toEqual(frozen);
          expect((yield* f.session()).historySeq).toBe(2);
          expect((yield* f.histories.read(f.address))!.history.revision.last_seq).toBe(
            fault === "lost-ack" ? 3 : 2,
          );
          const saved = yield* f.objects.getVersioned(f.key);
          failing = false;
          f.setTime(new Date("2026-10-11T12:00:00.000Z"));
          yield* makeReplySettlement(f.db, histories, f.clock).publish(f.replyId);
          expect(writes).toBe(1);
          if (fault === "lost-ack") expect(yield* f.objects.getVersioned(f.key)).toEqual(saved);
          expect((yield* f.histories.read(f.address))!.history.records[2]).toEqual({
            ...decodePayload(frozen.settlement),
            seq: 3,
          });
          expect((yield* f.session()).historySeq).toBe(3);
        }),
      ),
  );

  it.each([
    ["freeze", "rollback"],
    ["freeze", "lost-ack"],
    ["publish", "rollback"],
    ["publish", "lost-ack"],
  ] as const)(
    "recovers %s transaction %s without repeating a committed transition",
    (step, phase) =>
      withSettlement((f) =>
        Effect.gen(function* () {
          if (step === "publish") yield* f.finalizer.begin(f.replyId, completion());
          const before = yield* f.reply();
          const bytes = yield* f.objects.getVersioned(f.key);
          const fault = new Error(`${step} ${phase}`);
          const broken = makeReplySettlement(
            failTransactions(f.db, fault, phase),
            f.histories,
            f.clock,
          );
          expectDefect(
            yield* Effect.exit(
              step === "freeze" ? broken.begin(f.replyId, completion()) : broken.publish(f.replyId),
            ),
            fault,
          );
          const after = yield* f.reply();
          if (phase === "rollback") expect(after).toEqual(before);
          else expect(after.status).toBe(step === "freeze" ? "settling" : "completed");
          expect((yield* f.session()).historySeq).toBe(
            step === "publish" && phase === "lost-ack" ? 3 : 2,
          );
          const saved = yield* f.objects.getVersioned(f.key);
          if (step === "freeze") expect(saved).toEqual(bytes);
          else expect((yield* f.histories.read(f.address))!.history.revision.last_seq).toBe(3);
          if (step === "freeze") {
            yield* f.finalizer.begin(f.replyId, completion());
            if (phase === "lost-ack") expect(yield* f.reply()).toEqual(after);
          }
          expect(yield* f.finalizer.publish(f.replyId)).toBe(
            !(step === "publish" && phase === "lost-ack"),
          );
          const terminal = yield* f.reply();
          expect(terminal).toMatchObject({ status: "completed", version: 3, settlement: null });
          if (step === "publish") expect(yield* f.objects.getVersioned(f.key)).toEqual(saved);
          if (step === "publish" && phase === "lost-ack") expect(terminal).toEqual(after);
        }),
      ),
  );

  it("refuses absent admission receipts and mismatching publication receipts without modifying history", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        const before = yield* f.reply();
        yield* f.updateSession({ historySeq: null, historySha256: null });
        expect(
          failure(yield* Effect.exit(f.finalizer.begin(f.replyId, completion()))),
        ).toMatchObject({ _tag: "ReplySettlementInvalid", reason: "history_receipt" });
        expect(yield* f.reply()).toEqual(before);
        yield* f.updateSession({
          historySeq: 2,
          historySha256: f.admission.history.revision.sha256,
        });
        yield* f.finalizer.begin(f.replyId, completion());
        const frozen = yield* f.reply();
        const bytes = yield* f.objects.getVersioned(f.key);
        yield* f.updateSession({ historySha256: FileFingerprint.make("0".repeat(64)) });
        expect(failure(yield* Effect.exit(f.finalizer.publish(f.replyId)))).toMatchObject({
          _tag: "HistoryInvalid",
          reason: "history_receipt",
        });
        expect(yield* f.reply()).toEqual(frozen);
        expect(yield* f.objects.getVersioned(f.key)).toEqual(bytes);
      }),
    ));

  it.each(["changed-hash", "advanced"] as const)(
    "refuses a %s receipt during DB publication without overwriting it",
    (race) =>
      withSettlement((f) =>
        Effect.gen(function* () {
          yield* f.finalizer.begin(f.replyId, completion());
          const histories: HistoryStoreShape = {
            ...f.histories,
            commit: (...args) =>
              Effect.gen(function* () {
                const saved = yield* f.histories.commit(...args);
                if (race === "advanced") {
                  const advanced = yield* f.histories.commit(f.address, [
                    attempt({
                      reply_id: uuid(500),
                      exchange_id: uuid(501),
                      parent_reply_id: f.replyId,
                    }),
                  ]);
                  yield* f.updateSession({
                    historySeq: advanced.history.revision.last_seq,
                    historySha256: advanced.history.revision.sha256,
                  });
                } else
                  yield* f.updateSession({ historySha256: FileFingerprint.make("0".repeat(64)) });
                return saved;
              }),
          };
          expect(
            failure(
              yield* Effect.exit(makeReplySettlement(f.db, histories, f.clock).publish(f.replyId)),
            ),
          ).toMatchObject({ _tag: "HistoryInvalid", reason: "history_receipt" });
          expect((yield* f.reply()).status).toBe("settling");
          expect((yield* f.histories.read(f.address))!.history.revision.last_seq).toBe(
            race === "advanced" ? 4 : 3,
          );
          if (race === "changed-hash")
            expect((yield* f.session()).historySha256).toBe("0".repeat(64));
          else {
            expect((yield* f.session()).historySeq).toBe(4);
            yield* f.finalizer.publish(f.replyId);
            expect((yield* f.reply()).status).toBe("completed");
            expect((yield* f.session()).historySeq).toBe(4);
          }
        }),
      ),
  );

  it.each(["completed", "stopped", "failed"] as const)(
    "restores recorded %s only against a fresh receipt, without late Stop or another write",
    (status) =>
      withSettlement((f) =>
        Effect.gen(function* () {
          const recorded = yield* f.histories.commit(
            f.address,
            [
              settlement({
                reply_id: f.replyId,
                outcome:
                  status === "failed"
                    ? { status, code: "generation_failed", message: "Recorded failure" }
                    : { status },
              }),
            ],
            f.admission.history.revision,
          );
          const histories: HistoryStoreShape = {
            ...f.histories,
            read: (address, receipt) =>
              Effect.gen(function* () {
                const original = yield* f.histories.read(address, receipt);
                const next = yield* f.histories
                  .commit(
                    address,
                    [
                      attempt({
                        reply_id: uuid(41),
                        exchange_id: uuid(42),
                        parent_reply_id: status === "failed" ? null : f.replyId,
                      }),
                    ],
                    recorded.history.revision,
                  )
                  .pipe(Effect.orDie);
                yield* f.histories
                  .commit(address, [settlement({ reply_id: uuid(41) })])
                  .pipe(Effect.orDie);
                yield* f.updateSession({
                  historySeq: next.history.revision.last_seq,
                  historySha256: next.history.revision.sha256,
                });
                return original;
              }),
          };
          yield* f.updateReply({ stopRequested: true });
          const before = yield* f.reply();
          yield* expectFailure(
            makeReplySettlement(f.db, histories, f.clock).restoreRecorded(f.replyId),
            "HistoryInvalid",
          );
          expect(yield* f.reply()).toEqual(before);
          expect((yield* f.session()).historySeq).toBe(4);
          const bytes = yield* f.objects.getVersioned(f.key);
          yield* f.finalizer.restoreRecorded(f.replyId);
          const restored = yield* f.reply();
          expect(restored).toMatchObject({
            status,
            answer: settlement().answer,
            sources: settlement().sources,
            error: status === "failed" ? "Recorded failure" : null,
            settlement: null,
            activeGenerationStep: null,
            version: before.version + 1,
          });
          expect((yield* f.session()).historySeq).toBe(5);
          yield* f.finalizer.restoreRecorded(f.replyId);
          expect(yield* f.finalizer.begin(f.replyId, interruption("stopped"))).toBe(false);
          expect(yield* f.reply()).toEqual(restored);
          expect(yield* f.objects.getVersioned(f.key)).toEqual(bytes);
        }),
      ),
  );

  it("rejects malformed and misidentified pending payloads before writing, and preserves conflicting saved content", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        yield* f.finalizer.begin(f.replyId, completion());
        const frozen = yield* f.reply();
        const payload = decodePayload(frozen.settlement);
        const bytes = yield* f.objects.getVersioned(f.key);
        for (const [invalid, reason] of [
          ...["generation", "context_messages", "settled_at"].map(
            (field) => [{ ...payload, [field]: null }, "settlement_payload"] as const,
          ),
          [{ ...payload, reply_id: uuid(999) }, "settlement_identity"],
        ] as const) {
          yield* f.updateReply({ settlement: invalid });
          expect(failure(yield* Effect.exit(f.finalizer.publish(f.replyId)))).toMatchObject({
            _tag: "ReplySettlementInvalid",
            reason,
          });
          expect((yield* f.reply()).status).toBe("settling");
          expect(yield* f.objects.getVersioned(f.key)).toEqual(bytes);
        }
        yield* f.updateReply({ settlement: payload });
        const restored = yield* f.reply();
        yield* f.histories.commit(f.address, [{ ...payload, answer: "Conflicting saved result" }]);
        const conflicting = yield* f.objects.getVersioned(f.key);
        expect(failure(yield* Effect.exit(f.finalizer.publish(f.replyId)))).toMatchObject({
          _tag: "HistoryConflict",
        });
        expect(yield* f.reply()).toEqual(restored);
        expect(yield* f.objects.getVersioned(f.key)).toEqual(conflicting);
      }),
    ));

  it("enforces receipt and pending-payload constraints in PostgreSQL", () =>
    withSettlement((f) =>
      Effect.gen(function* () {
        const originalSession = yield* f.session();
        for (const [seq, hash] of [
          [2, null],
          [null, "0".repeat(64)],
          [0, "0".repeat(64)],
          [Number.MAX_SAFE_INTEGER + 1, "0".repeat(64)],
          [2, "z".repeat(64)],
        ] as const) {
          const result = yield* Effect.exit(
            f.db.query((db) =>
              db.execute(
                sql`UPDATE sessions SET history_seq = ${seq}, history_sha256 = ${hash} WHERE vault_id = ${f.vaultId}`,
              ),
            ),
          );
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result))
            expect(Cause.pretty(result.cause)).toContain("sessions_history_receipt_check");
          expect(yield* f.session()).toEqual(originalSession);
        }
        const originalReply = yield* f.reply();
        for (const values of [
          { status: "settling", settlement: null },
          { status: "running", settlement: {} },
          { status: "completed", settlement: {} },
        ] as const) {
          const result = yield* Effect.exit(f.updateReply(values));
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result))
            expect(Cause.pretty(result.cause)).toContain("replies_settlement_check");
          expect(yield* f.reply()).toEqual(originalReply);
        }
      }),
    ));
});
