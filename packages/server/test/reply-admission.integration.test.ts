import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { type Database, replies, sessions } from "@great-minds/database";
import { type CreateReplyRequest, type SessionId, Uuid } from "@great-minds/domain";
import { and, eq } from "drizzle-orm";
import { Cause, Deferred, Effect, Exit, Fiber, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { AcceptedReplyRequest } from "../src/conversation-history/admission.ts";
import { makeReplySettlement } from "../src/conversation-history/settlement.ts";
import { type HistoryStoreShape, makeHistoryStore } from "../src/conversation-history/store.ts";
import { ObjectVersionConflict, storageBackendError } from "../src/storage/object-store.ts";
import { attempt, completion, settlement, timestamp } from "./fixtures/conversation-history.ts";
import { expectFailure, failure } from "./fixtures/history-storage.ts";
import { command, type ReplyAdmissionFixture, withAdmission } from "./fixtures/reply-admission.ts";
import { failTransactions } from "./fixtures/transaction-failure.ts";

const decodeRequest = Schema.decodeUnknownSync(AcceptedReplyRequest);
const nextId = () => Uuid.make(randomUUID());
const btwCommand = () =>
  command({
    session: {
      kind: "new",
      idempotency_key: randomUUID(),
      conversation_kind: "btw",
      origin_scope: "vault",
      origin: {
        kind: "document",
        doc_path: "wiki/meaning.md",
        origin_scope: "vault",
        anchor: "Passage",
        paragraph: "Passage in context",
        paragraph_index: 0,
      },
    },
  });
const followUp = (id: SessionId, overrides: Partial<CreateReplyRequest> = {}) =>
  command({ session: { kind: "existing", id }, ...overrides });
const answerThread = (sessionId: SessionId, exchangeId: Uuid) =>
  command({
    session: {
      kind: "new",
      idempotency_key: randomUUID(),
      conversation_kind: "btw",
      origin_scope: "vault",
      origin: {
        kind: "answer",
        session_id: sessionId,
        exchange_id: exchangeId,
        anchor: "Answer",
        paragraph: "Answer",
        paragraph_index: 0,
      },
    },
  });
const failReply = (f: ReplyAdmissionFixture, replyId: Uuid) =>
  f.finalize(replyId, {
    status: "failed",
    code: "generation_failed",
    message: "Failed",
    generation: null,
    context_messages: null,
  });

describe("durable admission", () => {
  it("reserves exact input, freezes accepted mode, acknowledges before running and reuses terminal identity", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = btwCommand();
        const response = yield* f.admission.reserve(f.userId, f.vaultId, input);
        const reserved = yield* f.reply(input.reply_id);
        const request = decodeRequest(reserved.request);
        expect(reserved).toMatchObject({ status: "admitting", version: 0, dispatchedAt: null });
        expect(request).toMatchObject({
          command: input,
          mode: "btw",
          attempt: {
            reply_id: input.reply_id,
            exchange_id: input.exchange_id,
            accepted_at: timestamp,
            parent_reply_id: null,
            previous_attempt_id: null,
          },
        });
        expect(yield* f.histories.read(f.address(response.session_id))).toBeNull();
        expect((yield* f.session(response.session_id)).historySeq).toBeNull();
        yield* f.updateSession(response.session_id, {
          placement: "standalone",
          replyMode: "query",
        });
        expect(yield* f.admission.accept(f.userId, f.vaultId, input)).toEqual(response);
        const history = (yield* f.histories.read(f.address(response.session_id)))!.history;
        expect(history.records).toEqual([
          { ...request.header, seq: 1 },
          { ...request.attempt, seq: 2 },
        ]);
        expect(yield* f.reply(input.reply_id)).toMatchObject({
          status: "running",
          version: 1,
          request: reserved.request,
        });
        expect(yield* f.session(response.session_id)).toMatchObject({
          historySeq: 2,
          historySha256: history.revision.sha256,
        });
        yield* f.finalize(input.reply_id);
        const terminal = yield* f.reply(input.reply_id);
        const bytes = yield* f.objects.getVersioned(f.key(response.session_id));
        expect(yield* f.admission.accept(f.userId, f.vaultId, input)).toEqual(response);
        yield* expectFailure(
          f.admission.accept(f.userId, f.vaultId, { ...input, question: "Changed" }),
          "Conflict",
        );
        expect(yield* f.reply(input.reply_id)).toEqual(terminal);
        expect(yield* f.objects.getVersioned(f.key(response.session_id))).toEqual(bytes);
        const next = command({ session: input.session });
        expect((yield* f.admission.accept(f.userId, f.vaultId, next)).session_id).toBe(
          response.session_id,
        );
        expect(decodeRequest((yield* f.reply(next.reply_id)).request)).toMatchObject({
          header: null,
          mode: "query",
        });
        expect(yield* f.allSessions()).toHaveLength(1);
      }),
    ));

  it.each(["unavailable", "conflict", "lost-ack"] as const)(
    "retains exact admission after %s without inline writes",
    (fault) =>
      withAdmission((f) =>
        Effect.gen(function* () {
          const input = command();
          let broken = true;
          let calls = 0;
          let writes = 0;
          const histories = makeHistoryStore({
            ...f.objects,
            putIfVersion: (...args) =>
              Effect.gen(function* () {
                calls += 1;
                if (!broken || fault === "lost-ack") {
                  yield* f.objects.putIfVersion(...args);
                  writes += 1;
                }
                if (broken)
                  return yield* fault === "conflict"
                    ? new ObjectVersionConflict({ key: args[0] })
                    : storageBackendError("write", args[0], new Error(fault));
              }),
          });
          yield* expectFailure(
            f.coordinator({ histories }).accept(f.userId, f.vaultId, input),
            fault === "conflict" ? "ObjectVersionConflict" : "StorageBackendError",
          );
          expect(calls).toBe(1);
          const reserved = yield* f.reply(input.reply_id);
          expect(reserved.status).toBe("admitting");
          const saved = yield* f.histories.read(f.address(reserved.sessionId!));
          expect(saved === null).toBe(fault !== "lost-ack");
          broken = false;
          f.setTime(new Date("2026-10-12T12:00:00.000Z"));
          const response = yield* f
            .coordinator({ histories, configured: false })
            .accept(f.userId, f.vaultId, input);
          expect(response.session_id).toBe(reserved.sessionId);
          expect((yield* f.reply(input.reply_id)).request).toEqual(reserved.request);
          expect(writes).toBe(1);
          const recorded = yield* f.histories.read(f.address(response.session_id));
          expect(recorded!.history.records[1]).toEqual({
            ...decodeRequest(reserved.request).attempt,
            seq: 2,
          });
          if (saved) expect(recorded).toEqual(saved);
        }),
      ),
  );

  it.each([
    ["reserve", "rollback"],
    ["reserve", "lost-ack"],
    ["admit", "rollback"],
    ["admit", "lost-ack"],
  ] as const)(
    "recovers %s transaction %s without orphaning a session or repeating a transition",
    (step, fault) =>
      withAdmission((f) =>
        Effect.gen(function* () {
          const input = command();
          if (step === "admit") yield* f.admission.reserve(f.userId, f.vaultId, input);
          const defect = new Error(fault);
          const broken = f.coordinator({ db: failTransactions(f.db, defect, fault) });
          const exit = yield* Effect.exit(
            Effect.gen(function* () {
              if (step === "reserve") yield* broken.reserve(f.userId, f.vaultId, input);
              else yield* broken.admit(input.reply_id);
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect);
          const exists = step === "admit" || fault === "lost-ack";
          expect(yield* f.allSessions()).toHaveLength(exists ? 1 : 0);
          expect(yield* f.allReplies()).toHaveLength(exists ? 1 : 0);
          const before = yield* f.reply(input.reply_id);
          if (before) {
            expect(before.status).toBe(
              step === "admit" && fault === "lost-ack" ? "running" : "admitting",
            );
            expect((yield* f.session(before.sessionId!)).historySeq).toBe(
              before.status === "running" ? 2 : null,
            );
          }
          const saved = before && (yield* f.histories.read(f.address(before.sessionId!)));
          const response = yield* f.admission.accept(f.userId, f.vaultId, input);
          if (before) expect(response.session_id).toBe(before.sessionId);
          const admitted = yield* f.reply(input.reply_id);
          expect(admitted).toMatchObject({ status: "running", version: 1 });
          if (before) expect(admitted.request).toEqual(before.request);
          if (before?.status === "running") expect(admitted).toEqual(before);
          if (saved) expect(yield* f.histories.read(f.address(response.session_id))).toEqual(saved);
          expect((yield* f.session(response.session_id)).historySeq).toBe(2);
        }),
      ),
  );

  it.each(["admitting", "running", "settling"] as const)(
    "enforces the live slot in coordinator and PostgreSQL while %s",
    (status) =>
      withAdmission((f) =>
        Effect.gen(function* () {
          const input = command();
          const response = yield* f.admission.reserve(f.userId, f.vaultId, input);
          const finalizer = makeReplySettlement(f.db, f.histories, f.clock);
          if (status !== "admitting") yield* f.admission.admit(input.reply_id);
          if (status === "settling") yield* finalizer.begin(input.reply_id, completion());
          if (status === "admitting")
            expect(yield* finalizer.begin(input.reply_id, completion())).toBe(false);
          expect(yield* f.admission.reserve(f.userId, f.vaultId, input)).toEqual(response);
          yield* expectFailure(
            f.admission.reserve(f.userId, f.vaultId, followUp(response.session_id)),
            "Conflict",
          );
          const direct = yield* Effect.exit(
            f.db.query((db) =>
              db.insert(replies).values({
                id: nextId(),
                vaultId: f.vaultId,
                userId: f.userId,
                sessionId: response.session_id,
                status: "running",
                request: {},
              }),
            ),
          );
          expect(Exit.isFailure(direct)).toBe(true);
          if (Exit.isFailure(direct))
            expect(Cause.pretty(direct.cause)).toContain("uq_replies_live_session");
          expect(yield* f.allReplies()).toHaveLength(1);
        }),
      ),
  );

  it.each([false, true])(
    "serializes new-session requests sharing identity with conflict=%s",
    (conflict) =>
      withAdmission((f) =>
        Effect.gen(function* () {
          const first = command();
          const second = conflict ? { ...first, question: "Different" } : first;
          const results = yield* Effect.all(
            [first, second].map((input) =>
              Effect.result(f.admission.reserve(f.userId, f.vaultId, input)),
            ),
            { concurrency: 2 },
          );
          const accepted = results.filter(Result.isSuccess).map((result) => result.success);
          expect(accepted).toHaveLength(conflict ? 1 : 2);
          expect(new Set(accepted.map((result) => result.session_id)).size).toBe(1);
          expect(results.filter(Result.isFailure).map((result) => result.failure._tag)).toEqual(
            conflict ? ["Conflict"] : [],
          );
          expect(yield* f.allSessions()).toHaveLength(1);
          expect(yield* f.allReplies()).toHaveLength(1);
        }),
      ),
  );

  it("reserves only one simultaneous follow-up in an existing conversation", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const first = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, first);
        yield* f.finalize(first.reply_id);
        const results = yield* Effect.all(
          [followUp(response.session_id), followUp(response.session_id)].map((input) =>
            Effect.result(f.admission.reserve(f.userId, f.vaultId, input)),
          ),
          { concurrency: 2 },
        );
        expect(results.filter(Result.isSuccess)).toHaveLength(1);
        expect(results.filter(Result.isFailure).map((result) => result.failure._tag)).toEqual([
          "Conflict",
        ]);
        expect(yield* f.allReplies()).toHaveLength(2);
      }),
    ));

  it("refuses missing generation configuration and unauthorized callers without private reads or new rows", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        yield* expectFailure(
          f.coordinator({ configured: false }).accept(f.userId, f.vaultId, command()),
          "ServiceUnavailable",
        );
        expect(yield* f.allSessions()).toHaveLength(0);
        expect(yield* f.allReplies()).toHaveLength(0);
        const input = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, input);
        let reads = 0;
        const coordinator = f.coordinator({
          histories: {
            ...f.histories,
            read: (...args) => {
              reads += 1;
              return f.histories.read(...args);
            },
          },
        });
        for (const [user, request, tag] of [
          [f.outsiderId, command(), "Forbidden"],
          [f.memberId, followUp(response.session_id), "NotFound"],
          [f.memberId, input, "Conflict"],
        ] as const)
          yield* expectFailure(coordinator.accept(user, f.vaultId, request), tag);
        expect(reads).toBe(0);
        expect(yield* f.allReplies()).toHaveLength(1);
      }),
    ));

  it("reads future mode under the session lock during concurrent Continue", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const first = btwCommand();
        const response = yield* f.admission.accept(f.userId, f.vaultId, first);
        yield* f.finalize(first.reply_id);
        const locked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const reserving = yield* Deferred.make<void>();
        const where = and(eq(sessions.id, response.session_id), eq(sessions.vaultId, f.vaultId));
        const continuation = yield* Effect.forkChild(
          f.db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.select().from(sessions).where(where).for("update");
              yield* Deferred.succeed(locked, undefined);
              yield* Deferred.await(release);
              yield* tx
                .update(sessions)
                .set({ placement: "standalone", replyMode: "query" })
                .where(where);
            }),
          ),
        );
        yield* Deferred.await(locked);
        const db: Database["Service"] = {
          ...f.db,
          transaction: (run) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(reserving, undefined);
              return yield* f.db.transaction(run);
            }),
        };
        const next = followUp(response.session_id);
        const reservation = yield* Effect.forkChild(
          f.coordinator({ db }).reserve(f.userId, f.vaultId, next),
        );
        yield* Deferred.await(reserving);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(continuation);
        yield* Fiber.join(reservation);
        expect(decodeRequest((yield* f.reply(next.reply_id)).request).mode).toBe("query");
      }),
    ));

  it("keeps history I/O outside reservation and admission transactions", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        let inTransaction = false;
        const db: Database["Service"] = {
          ...f.db,
          transaction: (run) =>
            f.db.transaction((tx) =>
              Effect.gen(function* () {
                inTransaction = true;
                return yield* run(tx).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      inTransaction = false;
                    }),
                  ),
                );
              }),
            ),
        };
        const histories: HistoryStoreShape = {
          read: (...args) => {
            expect(inTransaction).toBe(false);
            return f.histories.read(...args);
          },
          commit: (...args) => {
            expect(inTransaction).toBe(false);
            return f.histories.commit(...args);
          },
        };
        const coordinator = f.coordinator({ db, histories });
        const first = command();
        const response = yield* coordinator.accept(f.userId, f.vaultId, first);
        yield* f.finalize(first.reply_id);
        yield* coordinator.accept(f.userId, f.vaultId, followUp(response.session_id));
      }),
    ));

  it("rejects a stale parent receipt before reservation and uses the fresh parent on redelivery", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const first = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, first);
        yield* f.finalize(first.reply_id);
        const next = followUp(response.session_id);
        const other = followUp(response.session_id);
        let changed = false;
        const db: Database["Service"] = {
          ...f.db,
          transaction: (run) =>
            Effect.gen(function* () {
              if (!changed) {
                changed = true;
                yield* f.admission.accept(f.userId, f.vaultId, other).pipe(Effect.orDie);
                yield* f.finalize(other.reply_id).pipe(Effect.orDie);
              }
              return yield* f.db.transaction(run);
            }),
        };
        yield* expectFailure(f.coordinator({ db }).reserve(f.userId, f.vaultId, next), "Conflict");
        expect(yield* f.reply(next.reply_id)).toBeUndefined();
        yield* f.admission.reserve(f.userId, f.vaultId, next);
        expect(decodeRequest((yield* f.reply(next.reply_id)).request).attempt.parent_reply_id).toBe(
          other.reply_id,
        );
      }),
    ));

  it("skips failed context and retries only the selected attempt with its original question, exchange and parent", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const first = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, first);
        yield* f.finalize(first.reply_id);
        const failed = followUp(response.session_id);
        yield* f.admission.accept(f.userId, f.vaultId, failed);
        yield* failReply(f, failed.reply_id);
        const later = followUp(response.session_id);
        yield* f.admission.accept(f.userId, f.vaultId, later);
        expect(
          decodeRequest((yield* f.reply(later.reply_id)).request).attempt.parent_reply_id,
        ).toBe(first.reply_id);
        yield* f.finalize(later.reply_id);
        yield* expectFailure(
          f.admission.accept(
            f.userId,
            f.vaultId,
            followUp(response.session_id, { exchange_id: failed.exchange_id }),
          ),
          "Conflict",
        );
        const retryId = nextId();
        yield* f.admission.retry(f.userId, f.vaultId, failed.reply_id, retryId);
        expect(decodeRequest((yield* f.reply(retryId)).request).attempt).toMatchObject({
          reply_id: retryId,
          exchange_id: failed.exchange_id,
          previous_attempt_id: failed.reply_id,
          parent_reply_id: first.reply_id,
          question: failed.question,
        });
        yield* failReply(f, retryId);
        yield* expectFailure(
          f.admission.retry(f.userId, f.vaultId, failed.reply_id, nextId()),
          "Conflict",
        );
        const successorId = nextId();
        yield* f.admission.retry(f.userId, f.vaultId, retryId, successorId);
        yield* expectFailure(
          f.admission.retry(f.userId, f.vaultId, failed.reply_id, successorId),
          "Conflict",
        );
      }),
    ));

  it.each(["completed", "failed"] as const)(
    "redelivers an exact retry after %s without another operation or write",
    (status) =>
      withAdmission((f) =>
        Effect.gen(function* () {
          const input = command();
          const response = yield* f.admission.accept(f.userId, f.vaultId, input);
          yield* failReply(f, input.reply_id);
          const retryId = nextId();
          const accepted = yield* f.admission.retry(f.userId, f.vaultId, input.reply_id, retryId);
          expect(yield* f.admission.retry(f.userId, f.vaultId, input.reply_id, retryId)).toEqual(
            accepted,
          );
          yield* status === "completed" ? f.finalize(retryId) : failReply(f, retryId);
          const before = yield* f.objects.getVersioned(f.key(response.session_id));
          expect(yield* f.admission.retry(f.userId, f.vaultId, input.reply_id, retryId)).toEqual(
            accepted,
          );
          expect(
            yield* f.admission.accept(
              f.userId,
              f.vaultId,
              decodeRequest((yield* f.reply(retryId)).request).command,
            ),
          ).toEqual(accepted);
          expect((yield* f.reply(retryId)).status).toBe(status);
          expect(yield* f.allReplies()).toHaveLength(2);
          expect(yield* f.objects.getVersioned(f.key(response.session_id))).toEqual(before);
        }),
      ),
  );

  it.each(["completed", "stopped"] as const)("does not retry %s", (status) =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        yield* f.admission.accept(f.userId, f.vaultId, input);
        yield* f.finalize(
          input.reply_id,
          status === "completed"
            ? completion()
            : { status, generation: null, context_messages: [] },
        );
        yield* expectFailure(
          f.admission.retry(f.userId, f.vaultId, input.reply_id, nextId()),
          "BadRequest",
        );
      }),
    ),
  );

  it("separates annotation from context and freezes the cutoff while the parent advances", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const first = command();
        const parent = yield* f.admission.accept(f.userId, f.vaultId, first);
        yield* f.finalize(first.reply_id);
        const second = followUp(parent.session_id);
        yield* f.admission.accept(f.userId, f.vaultId, second);
        yield* f.finalize(second.reply_id);
        const pending = followUp(parent.session_id);
        yield* f.admission.accept(f.userId, f.vaultId, pending);
        const input = answerThread(parent.session_id, first.exchange_id);
        const child = yield* f.admission.reserve(f.userId, f.vaultId, input);
        const original = decodeRequest((yield* f.reply(input.reply_id)).request);
        expect(original.header).toMatchObject({
          anchor_reply_id: first.reply_id,
          context: { session_id: parent.session_id, reply_id: second.reply_id },
        });
        yield* f.finalize(pending.reply_id);
        yield* f.admission.admit(input.reply_id);
        expect((yield* f.histories.read(f.address(child.session_id)))!.history.header).toEqual({
          ...original.header,
          seq: 1,
        });
      }),
    ));

  it("rejects nested inline origins, other owners and absent answers before reserving a child", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = btwCommand();
        const parent = yield* f.admission.accept(f.userId, f.vaultId, input);
        yield* f.finalize(input.reply_id);
        yield* expectFailure(
          f.admission.reserve(
            f.userId,
            f.vaultId,
            answerThread(parent.session_id, input.exchange_id),
          ),
          "BadRequest",
        );
        yield* f.updateSession(parent.session_id, { placement: "standalone", replyMode: "query" });
        yield* expectFailure(
          f.admission.reserve(
            f.memberId,
            f.vaultId,
            answerThread(parent.session_id, input.exchange_id),
          ),
          "NotFound",
        );
        yield* expectFailure(
          f.admission.reserve(f.userId, f.vaultId, answerThread(parent.session_id, nextId())),
          "BadRequest",
        );
        expect(yield* f.allSessions()).toHaveLength(1);
      }),
    ));

  it.each(["missing", "orphan", "suffix", "unknown-context"] as const)(
    "refuses %s history without reserving or repairing",
    (state) =>
      withAdmission((f) =>
        Effect.gen(function* () {
          const input = command();
          const response = yield* f.admission.accept(f.userId, f.vaultId, input);
          if (state !== "orphan")
            yield* f.finalize(
              input.reply_id,
              state === "unknown-context"
                ? { status: "stopped", generation: null, context_messages: null }
                : completion(),
            );
          if (state === "missing")
            yield* Effect.promise(() => unlink(join(f.directory, f.key(response.session_id))));
          if (state === "orphan")
            yield* f.db.query((db) => db.delete(replies).where(eq(replies.id, input.reply_id)));
          if (state === "suffix")
            yield* f.histories.commit(f.address(response.session_id), [
              attempt({
                reply_id: nextId(),
                exchange_id: nextId(),
                parent_reply_id: input.reply_id,
              }),
            ]);
          const before = yield* f.histories.read(f.address(response.session_id));
          const next = followUp(response.session_id);
          yield* expectFailure(
            f.admission.reserve(f.userId, f.vaultId, next),
            state === "missing"
              ? "HistoryInvalid"
              : state === "unknown-context"
                ? "BadRequest"
                : "Conflict",
          );
          expect(yield* f.reply(next.reply_id)).toBeUndefined();
          expect(yield* f.histories.read(f.address(response.session_id))).toEqual(before);
        }),
      ),
  );

  it("does not overwrite a receipt advanced after the admission write", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.reserve(f.userId, f.vaultId, input);
        const histories: HistoryStoreShape = {
          ...f.histories,
          commit: (...args) =>
            Effect.gen(function* () {
              const committed = yield* f.histories.commit(...args);
              const advanced = yield* f.histories.commit(f.address(response.session_id), [
                settlement({ reply_id: input.reply_id }),
              ]);
              yield* f.updateSession(response.session_id, {
                historySeq: advanced.history.revision.last_seq,
                historySha256: advanced.history.revision.sha256,
              });
              return committed;
            }),
        };
        yield* expectFailure(f.coordinator({ histories }).admit(input.reply_id), "HistoryInvalid");
        expect((yield* f.reply(input.reply_id)).status).toBe("admitting");
        expect((yield* f.session(response.session_id)).historySeq).toBe(3);
      }),
    ));

  it("rejects stored corruption before writing and rechecks descriptor identity after I/O", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.reserve(f.userId, f.vaultId, input);
        const request = decodeRequest((yield* f.reply(input.reply_id)).request);
        yield* f.updateReply(input.reply_id, { request: {} });
        expect(failure(yield* Effect.exit(f.admission.admit(input.reply_id)))).toMatchObject({
          reason: "request_payload",
        });
        expect(yield* f.histories.read(f.address(response.session_id))).toBeNull();
        yield* f.updateReply(input.reply_id, { request });
        const histories: HistoryStoreShape = {
          ...f.histories,
          commit: (...args) =>
            Effect.gen(function* () {
              const committed = yield* f.histories.commit(...args);
              yield* f.updateReply(input.reply_id, { request: { ...request, mode: "btw" } });
              return committed;
            }),
        };
        yield* expectFailure(
          f.coordinator({ histories }).admit(input.reply_id),
          "ReplyAdmissionInvalid",
        );
        expect((yield* f.reply(input.reply_id)).status).toBe("admitting");
      }),
    ));

  it("does not report acceptance when the reservation disappears", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const db: Database["Service"] = {
          ...f.db,
          transaction: (run) =>
            Effect.gen(function* () {
              const result = yield* f.db.transaction(run);
              yield* f.db.query((client) =>
                client.delete(replies).where(eq(replies.id, input.reply_id)),
              );
              return result;
            }),
        };
        yield* expectFailure(f.coordinator({ db }).accept(f.userId, f.vaultId, input), "NotFound");
        const [session] = yield* f.allSessions();
        expect(yield* f.histories.read(f.address(session.id))).toBeNull();
      }),
    ));

  it("never revives an admitting operation already settled in history", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.reserve(f.userId, f.vaultId, input);
        const request = decodeRequest((yield* f.reply(input.reply_id)).request);
        yield* f.histories.commit(f.address(response.session_id), [
          request.header!,
          request.attempt,
          settlement({ reply_id: input.reply_id }),
        ]);
        expect(failure(yield* Effect.exit(f.admission.admit(input.reply_id)))).toMatchObject({
          reason: "settled_attempt",
        });
        expect((yield* f.reply(input.reply_id)).status).toBe("admitting");
        expect((yield* f.session(response.session_id)).historySeq).toBeNull();
      }),
    ));

  it("confirms identical concurrent admission after its stale read and failed CAS", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        let injected = false;
        let conflicts = 0;
        const histories = makeHistoryStore({
          ...f.objects,
          getVersioned: (key) =>
            Effect.gen(function* () {
              const snapshot = yield* Effect.exit(f.objects.getVersioned(key));
              if (!injected) {
                injected = true;
                yield* f.admission.admit(input.reply_id).pipe(Effect.orDie);
              }
              if (Exit.isFailure(snapshot)) return yield* Effect.failCause(snapshot.cause);
              return snapshot.value;
            }),
          putIfVersion: (...args) =>
            f.objects.putIfVersion(...args).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  if (error._tag === "ObjectVersionConflict") conflicts += 1;
                }),
              ),
            ),
        });
        const response = yield* f.coordinator({ histories }).accept(f.userId, f.vaultId, input);
        expect(conflicts).toBe(1);
        expect((yield* f.reply(input.reply_id)).status).toBe("running");
        expect(
          (yield* f.histories.read(f.address(response.session_id)))!.history.records,
        ).toHaveLength(2);
      }),
    ));

  it("accepts a concurrently settled admission without reviving it", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const histories: HistoryStoreShape = {
          ...f.histories,
          commit: (...args) =>
            Effect.gen(function* () {
              yield* f.admission.admit(input.reply_id).pipe(Effect.orDie);
              yield* f.finalize(input.reply_id).pipe(Effect.orDie);
              return yield* f.histories.commit(...args);
            }),
        };
        const response = yield* f.coordinator({ histories }).accept(f.userId, f.vaultId, input);
        expect((yield* f.reply(input.reply_id)).status).toBe("completed");
        expect(
          (yield* f.histories.read(f.address(response.session_id)))!.history.records,
        ).toHaveLength(3);
      }),
    ));
});
