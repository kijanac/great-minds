import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { type Database, replies, sessions } from "@great-minds/database";
import { type CreateReplyRequest, type SessionId, Uuid } from "@great-minds/domain";
import { and, eq } from "drizzle-orm";
import { Cause, Deferred, Effect, Exit, Fiber, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { AcceptedReplyRequest, acceptedRequestFor } from "../src/conversation-history/admission.ts";
import { makeReplySettlement } from "../src/conversation-history/settlement.ts";
import { type HistoryStoreShape, makeHistoryStore } from "../src/conversation-history/store.ts";
import { ObjectVersionConflict, storageBackendError } from "../src/storage/object-store.ts";
import { settlement, timestamp } from "./fixtures/conversation-history.ts";
import { failure } from "./fixtures/history-storage.ts";
import { command, type ReplyAdmissionFixture, withAdmission } from "./fixtures/reply-admission.ts";
import { completion } from "./fixtures/reply-settlement.ts";

const decodeRequest = Schema.decodeUnknownSync(AcceptedReplyRequest);
const documentOrigin = {
  kind: "document",
  doc_path: "wiki/meaning.md",
  origin_scope: "vault",
  anchor: "A selected passage",
  paragraph: "A selected passage in context",
  paragraph_index: 0,
} as const;
const btwCommand = () =>
  command({
    session: {
      kind: "new",
      idempotency_key: randomUUID(),
      conversation_kind: "btw",
      origin_scope: "vault",
      origin: documentOrigin,
    },
  });
const followUp = (sessionId: SessionId, overrides: Partial<CreateReplyRequest> = {}) =>
  command({ session: { kind: "existing", id: sessionId }, ...overrides });
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
        anchor: "A considered answer.",
        paragraph: "A considered answer. é 漢字 [^1]",
        paragraph_index: 0,
      },
    },
  });
const failReply = (f: ReplyAdmissionFixture, replyId: Uuid) =>
  f.finalize(replyId, {
    status: "failed",
    code: "generation_failed",
    message: "The provider failed",
    generation: null,
    context_messages: null,
  });
const expectDefect = <Value, Error>(exit: Exit.Exit<Value, Error>, error: unknown) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(error);
};

const brokenTransactions = (
  db: Database["Service"],
  fault: Error,
  acknowledged: boolean,
): Database["Service"] => ({
  ...db,
  transaction: (run) =>
    acknowledged
      ? Effect.gen(function* () {
          yield* db.transaction(run);
          return yield* Effect.die(fault);
        })
      : db.transaction((tx) =>
          Effect.gen(function* () {
            yield* run(tx);
            return yield* Effect.die(fault);
          }),
        ),
});

describe("durable reply admission", () => {
  it("reserves the exact command before creating history and confirms admission before running", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.reserve(f.userId, f.vaultId, input);
        const reserved = yield* f.reply(input.reply_id);
        const request = decodeRequest(reserved.request);
        expect(reserved).toMatchObject({
          status: "admitting",
          version: 0,
          dispatchedAt: null,
          activeGenerationStep: null,
        });
        expect(request.command).toEqual(input);
        expect(request.mode).toBe("query");
        expect(request.attempt).toMatchObject({
          reply_id: input.reply_id,
          exchange_id: input.exchange_id,
          accepted_at: timestamp,
          parent_reply_id: null,
          previous_attempt_id: null,
        });
        expect(yield* f.histories.read(f.address(response.session_id))).toBeNull();
        expect((yield* f.session(response.session_id)).historySeq).toBeNull();
        expect(yield* f.admission.admit(input.reply_id)).toBe(true);
        const history = (yield* f.histories.read(f.address(response.session_id)))!.history;
        expect(history.records).toEqual([
          { ...request.header, seq: 1 },
          { ...request.attempt, seq: 2 },
        ]);
        expect(yield* f.reply(input.reply_id)).toMatchObject({
          status: "running",
          version: 1,
          request: reserved.request,
          dispatchedAt: null,
        });
        expect(yield* f.session(response.session_id)).toMatchObject({
          historySeq: 2,
          historySha256: history.revision.sha256,
        });
      }),
    ));

  it("accept returns only after the header and attempt are durably admitted", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, input);
        expect((yield* f.reply(input.reply_id)).status).toBe("running");
        expect(
          (yield* f.histories.read(f.address(response.session_id)))!.history.records,
        ).toHaveLength(2);
      }),
    ));

  it("keeps the same command, identifiers and acceptance time after storage failure and coordinator recreation", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const histories: HistoryStoreShape = {
          ...f.histories,
          commit: (address) =>
            Effect.fail(
              storageBackendError(
                "write",
                f.key(address.session_id),
                new Error("Storage unavailable"),
              ),
            ),
        };
        const unavailable = f.coordinator({ histories });
        expect(
          failure(yield* Effect.exit(unavailable.accept(f.userId, f.vaultId, input)))._tag,
        ).toBe("StorageBackendError");
        const reserved = yield* f.reply(input.reply_id);
        f.setTime(new Date("2026-10-12T12:00:00.000Z"));
        const response = yield* f
          .coordinator({ configured: false })
          .accept(f.userId, f.vaultId, input);
        expect(response.session_id).toBe(reserved.sessionId);
        expect((yield* f.reply(input.reply_id)).request).toEqual(reserved.request);
        expect(
          (yield* f.histories.read(f.address(response.session_id)))!.history.records[1],
        ).toMatchObject({ accepted_at: timestamp });
        expect(yield* f.allSessions()).toHaveLength(1);
      }),
    ));

  it("returns CAS conflict after one attempt and retains the admission obligation", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.reserve(f.userId, f.vaultId, input);
        let attempts = 0;
        const histories: HistoryStoreShape = {
          ...f.histories,
          commit: () =>
            Effect.gen(function* () {
              attempts += 1;
              return yield* new ObjectVersionConflict({ key: f.key(response.session_id) });
            }),
        };
        expect(
          failure(yield* Effect.exit(f.coordinator({ histories }).admit(input.reply_id)))._tag,
        ).toBe("ObjectVersionConflict");
        expect(attempts).toBe(1);
        expect((yield* f.reply(input.reply_id)).status).toBe("admitting");
        yield* f.admission.admit(input.reply_id);
      }),
    ));

  it("recognizes an admitted attempt after the storage acknowledgement is lost without writing twice", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.reserve(f.userId, f.vaultId, input);
        let writes = 0;
        const objects = {
          ...f.objects,
          putIfVersion: (...args: Parameters<typeof f.objects.putIfVersion>) =>
            Effect.gen(function* () {
              writes += 1;
              yield* f.objects.putIfVersion(...args);
              if (writes === 1)
                return yield* storageBackendError(
                  "write",
                  args[0],
                  new Error("Acknowledgement lost"),
                );
            }),
        };
        const coordinator = f.coordinator({ histories: makeHistoryStore(objects) });
        expect(failure(yield* Effect.exit(coordinator.admit(input.reply_id)))._tag).toBe(
          "StorageBackendError",
        );
        expect((yield* f.reply(input.reply_id)).status).toBe("admitting");
        const bytes = yield* f.objects.getVersioned(f.key(response.session_id));
        expect(yield* coordinator.admit(input.reply_id)).toBe(true);
        expect(writes).toBe(1);
        expect(yield* f.objects.getVersioned(f.key(response.session_id))).toEqual(bytes);
      }),
    ));

  it("rolls back interrupted reservation without leaving a session, reply or history", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const fault = new Error("Reservation interrupted");
        const coordinator = f.coordinator({ db: brokenTransactions(f.db, fault, false) });
        expectDefect(
          yield* Effect.exit(coordinator.reserve(f.userId, f.vaultId, command())),
          fault,
        );
        expect(yield* f.allReplies()).toHaveLength(0);
        expect(yield* f.allSessions()).toHaveLength(0);
      }),
    ));

  it("replays a committed reservation whose DB acknowledgement was lost", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const fault = new Error("Reservation acknowledgement lost");
        expectDefect(
          yield* Effect.exit(
            f
              .coordinator({ db: brokenTransactions(f.db, fault, true) })
              .reserve(f.userId, f.vaultId, input),
          ),
          fault,
        );
        const reserved = yield* f.reply(input.reply_id);
        const response = yield* f.admission.accept(f.userId, f.vaultId, input);
        expect(response.session_id).toBe(reserved.sessionId);
        expect((yield* f.reply(input.reply_id)).request).toEqual(reserved.request);
        expect(yield* f.allSessions()).toHaveLength(1);
      }),
    ));

  it("repairs DB admission rollback after history was saved", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.reserve(f.userId, f.vaultId, input);
        const fault = new Error("Admission transaction interrupted");
        expectDefect(
          yield* Effect.exit(
            f.coordinator({ db: brokenTransactions(f.db, fault, false) }).admit(input.reply_id),
          ),
          fault,
        );
        expect((yield* f.reply(input.reply_id)).status).toBe("admitting");
        expect((yield* f.session(response.session_id)).historySeq).toBeNull();
        const saved = yield* f.objects.getVersioned(f.key(response.session_id));
        yield* f.admission.admit(input.reply_id);
        expect(yield* f.objects.getVersioned(f.key(response.session_id))).toEqual(saved);
        expect((yield* f.session(response.session_id)).historySeq).toBe(2);
      }),
    ));

  it("does not repeat an admission transition after the DB acknowledgement is lost", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        yield* f.admission.reserve(f.userId, f.vaultId, input);
        const fault = new Error("Admission acknowledgement lost");
        expectDefect(
          yield* Effect.exit(
            f.coordinator({ db: brokenTransactions(f.db, fault, true) }).admit(input.reply_id),
          ),
          fault,
        );
        const admitted = yield* f.reply(input.reply_id);
        expect(yield* f.admission.admit(input.reply_id)).toBe(false);
        expect(yield* f.reply(input.reply_id)).toEqual(admitted);
        expect(admitted).toMatchObject({ status: "running", version: 1 });
      }),
    ));

  it.each(["admitting", "running", "settling"] as const)(
    "rejects another reply while %s but replays the same request first",
    (status) =>
      withAdmission((f) =>
        Effect.gen(function* () {
          const input = command();
          const response = yield* f.admission.reserve(f.userId, f.vaultId, input);
          if (status !== "admitting") yield* f.admission.admit(input.reply_id);
          if (status === "settling")
            yield* makeReplySettlement(f.db, f.histories, f.clock).begin(
              input.reply_id,
              completion(),
            );
          const before = yield* f.histories.read(f.address(response.session_id));
          expect(yield* f.admission.reserve(f.userId, f.vaultId, input)).toEqual(response);
          expect(
            failure(
              yield* Effect.exit(
                f.admission.reserve(f.userId, f.vaultId, followUp(response.session_id)),
              ),
            )._tag,
          ).toBe("Conflict");
          expect(yield* f.histories.read(f.address(response.session_id))).toEqual(before);
          expect(yield* f.allReplies()).toHaveLength(1);
          const direct = yield* Effect.exit(
            f.db.query((client) =>
              client.insert(replies).values({
                id: Uuid.make(randomUUID()),
                vaultId: f.vaultId,
                userId: f.userId,
                sessionId: response.session_id,
                kind: "exchange",
                status: "running",
                request: {},
              }),
            ),
          );
          expect(Exit.isFailure(direct)).toBe(true);
          if (Exit.isFailure(direct))
            expect(Cause.pretty(direct.cause)).toContain("uq_replies_live_session");
        }),
      ),
  );

  it("serializes simultaneous first submissions with one idempotency key", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const responses = yield* Effect.all(
          [
            f.admission.reserve(f.userId, f.vaultId, input),
            f.admission.reserve(f.userId, f.vaultId, input),
          ],
          { concurrency: 2 },
        );
        expect(responses[0]).toEqual(responses[1]);
        expect(yield* f.allSessions()).toHaveLength(1);
        expect(yield* f.allReplies()).toHaveLength(1);
        yield* f.admission.admit(input.reply_id);
        expect(
          (yield* f.histories.read(f.address(responses[0].session_id)))!.history.records,
        ).toHaveLength(2);
      }),
    ));

  it("allows only one of two different simultaneous replies in an existing conversation", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const first = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, first);
        yield* f.finalize(first.reply_id);
        const results = yield* Effect.all(
          [
            Effect.result(f.admission.reserve(f.userId, f.vaultId, followUp(response.session_id))),
            Effect.result(f.admission.reserve(f.userId, f.vaultId, followUp(response.session_id))),
          ],
          { concurrency: 2 },
        );
        expect(results.filter(Result.isSuccess)).toHaveLength(1);
        expect(results.filter(Result.isFailure).map((result) => result.failure._tag)).toEqual([
          "Conflict",
        ]);
        expect(yield* f.allReplies()).toHaveLength(2);
        expect(
          (yield* f.histories.read(f.address(response.session_id)))!.history.records,
        ).toHaveLength(3);
      }),
    ));

  it("allows separate conversations to reserve concurrently", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const responses = yield* Effect.all(
          [
            f.admission.reserve(f.userId, f.vaultId, command()),
            f.admission.reserve(f.userId, f.vaultId, command()),
          ],
          { concurrency: 2 },
        );
        expect(responses[0].session_id).not.toBe(responses[1].session_id);
        expect(yield* f.allSessions()).toHaveLength(2);
      }),
    ));

  it("rolls back a losing new session when simultaneous requests reuse a reply id differently", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const first = command();
        const second = command({ reply_id: first.reply_id, question: "A different question" });
        const results = yield* Effect.all(
          [
            Effect.result(f.admission.reserve(f.userId, f.vaultId, first)),
            Effect.result(f.admission.reserve(f.userId, f.vaultId, second)),
          ],
          { concurrency: 2 },
        );
        expect(results.filter(Result.isSuccess)).toHaveLength(1);
        expect(results.filter(Result.isFailure).map((result) => result.failure._tag)).toEqual([
          "Conflict",
        ]);
        expect(yield* f.allSessions()).toHaveLength(1);
        expect(yield* f.allReplies()).toHaveLength(1);
      }),
    ));

  it("rejects changed requests before touching history or creating another session", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, input);
        const bytes = yield* f.objects.getVersioned(f.key(response.session_id));
        expect(
          failure(
            yield* Effect.exit(
              f.admission.accept(f.userId, f.vaultId, command({ reply_id: input.reply_id })),
            ),
          )._tag,
        ).toBe("Conflict");
        expect(yield* f.objects.getVersioned(f.key(response.session_id))).toEqual(bytes);
        expect(yield* f.allSessions()).toHaveLength(1);
      }),
    ));

  it("rejects nonmembers and nonowners before reading private history", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, input);
        let reads = 0;
        const histories: HistoryStoreShape = {
          ...f.histories,
          read: (...args) => {
            reads += 1;
            return f.histories.read(...args);
          },
        };
        const coordinator = f.coordinator({ histories });
        expect(
          failure(yield* Effect.exit(coordinator.accept(f.outsiderId, f.vaultId, command())))._tag,
        ).toBe("Forbidden");
        expect(
          failure(
            yield* Effect.exit(
              coordinator.accept(f.memberId, f.vaultId, followUp(response.session_id)),
            ),
          )._tag,
        ).toBe("NotFound");
        expect(
          failure(yield* Effect.exit(coordinator.accept(f.memberId, f.vaultId, input)))._tag,
        ).toBe("Conflict");
        expect(reads).toBe(0);
        expect(yield* f.allReplies()).toHaveLength(1);
      }),
    ));

  it("does not create an operation when generation is unconfigured", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        expect(
          failure(
            yield* Effect.exit(
              f.coordinator({ configured: false }).accept(f.userId, f.vaultId, command()),
            ),
          )._tag,
        ).toBe("ServiceUnavailable");
        expect(yield* f.allReplies()).toHaveLength(0);
        expect(yield* f.allSessions()).toHaveLength(0);
      }),
    ));

  it("freezes the session default rather than the client mode and keeps it through continuation", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = btwCommand();
        expect(input.mode).toBe("query");
        const response = yield* f.admission.reserve(f.userId, f.vaultId, input);
        const original = yield* f.reply(input.reply_id);
        expect(decodeRequest(original.request).mode).toBe("btw");
        yield* f.db.query((client) =>
          client
            .update(sessions)
            .set({ kind: "session" })
            .where(and(eq(sessions.id, response.session_id), eq(sessions.vaultId, f.vaultId))),
        );
        yield* f.admission.admit(input.reply_id);
        expect((yield* f.reply(input.reply_id)).request).toEqual(original.request);
        yield* f.finalize(input.reply_id);
        const next = followUp(response.session_id, { mode: "btw" });
        yield* f.admission.reserve(f.userId, f.vaultId, next);
        expect(decodeRequest((yield* f.reply(next.reply_id)).request).mode).toBe("query");
      }),
    ));

  it("reads the effective mode under the same session lock as a concurrent continuation", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const first = btwCommand();
        const response = yield* f.admission.accept(f.userId, f.vaultId, first);
        yield* f.finalize(first.reply_id);
        const locked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const reserving = yield* Deferred.make<void>();
        const continuation = yield* Effect.forkChild(
          f.db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .select()
                .from(sessions)
                .where(and(eq(sessions.id, response.session_id), eq(sessions.vaultId, f.vaultId)))
                .for("update");
              yield* Deferred.succeed(locked, undefined);
              yield* Deferred.await(release);
              yield* tx
                .update(sessions)
                .set({ kind: "session" })
                .where(and(eq(sessions.id, response.session_id), eq(sessions.vaultId, f.vaultId)));
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

  it("does no object-store I/O inside reservation or admission transactions", () =>
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

  it("rejects a changed own-history receipt instead of accepting a stale parent", () =>
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
        expect(
          failure(yield* Effect.exit(f.coordinator({ db }).reserve(f.userId, f.vaultId, next)))
            ._tag,
        ).toBe("Conflict");
        expect(yield* f.reply(next.reply_id)).toBeUndefined();
        yield* f.admission.reserve(f.userId, f.vaultId, next);
        expect(decodeRequest((yield* f.reply(next.reply_id)).request).attempt.parent_reply_id).toBe(
          other.reply_id,
        );
      }),
    ));

  it("preserves a committed stop through admission without settling an unadmitted attempt", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        yield* f.admission.reserve(f.userId, f.vaultId, input);
        yield* f.db.query((client) =>
          client.update(replies).set({ stopRequested: true }).where(eq(replies.id, input.reply_id)),
        );
        const finalizer = makeReplySettlement(f.db, f.histories, f.clock);
        expect(yield* finalizer.begin(input.reply_id, completion())).toBe(false);
        yield* f.admission.admit(input.reply_id);
        expect((yield* f.reply(input.reply_id)).stopRequested).toBe(true);
        yield* finalizer.begin(input.reply_id, {
          status: "stopped",
          generation: null,
          context_messages: null,
        });
        yield* finalizer.publish(input.reply_id);
        expect((yield* f.reply(input.reply_id)).status).toBe("stopped");
      }),
    ));

  it("selects the latest usable parent while skipping failed exchanges", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const first = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, first);
        yield* f.finalize(first.reply_id);
        const second = followUp(response.session_id);
        yield* f.admission.accept(f.userId, f.vaultId, second);
        yield* failReply(f, second.reply_id);
        const third = followUp(response.session_id);
        yield* f.admission.reserve(f.userId, f.vaultId, third);
        expect(
          decodeRequest((yield* f.reply(third.reply_id)).request).attempt.parent_reply_id,
        ).toBe(first.reply_id);
      }),
    ));

  it("retries only the selected failed attempt while preserving its exchange, question and parent", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const first = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, first);
        yield* f.finalize(first.reply_id);
        const failed = followUp(response.session_id);
        yield* f.admission.accept(f.userId, f.vaultId, failed);
        yield* failReply(f, failed.reply_id);
        const retryId = Uuid.make(randomUUID());
        const retried = yield* f.admission.retry(f.userId, f.vaultId, failed.reply_id, retryId);
        expect(retried.session_id).toBe(response.session_id);
        expect(decodeRequest((yield* f.reply(retryId)).request).attempt).toMatchObject({
          reply_id: retryId,
          exchange_id: failed.exchange_id,
          previous_attempt_id: failed.reply_id,
          parent_reply_id: first.reply_id,
          question: failed.question,
        });
        expect(yield* f.admission.retry(f.userId, f.vaultId, failed.reply_id, retryId)).toEqual(
          retried,
        );
        yield* failReply(f, retryId);
        expect(
          failure(
            yield* Effect.exit(
              f.admission.retry(f.userId, f.vaultId, failed.reply_id, Uuid.make(randomUUID())),
            ),
          )._tag,
        ).toBe("Conflict");
        expect(
          (yield* f.histories.read(f.address(response.session_id)))!.history.turns[1]
            .selected_reply_id,
        ).toBe(retryId);
      }),
    ));

  it("does not treat ordinary creation as a retry of an existing exchange", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, input);
        yield* failReply(f, input.reply_id);
        expect(
          failure(
            yield* Effect.exit(
              f.admission.accept(
                f.userId,
                f.vaultId,
                followUp(response.session_id, { exchange_id: input.exchange_id }),
              ),
            ),
          )._tag,
        ).toBe("Conflict");
        expect(yield* f.allReplies()).toHaveLength(1);
      }),
    ));

  it.each(["completed", "stopped"] as const)("does not retry a %s attempt", (status) =>
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
        expect(
          failure(
            yield* Effect.exit(
              f.admission.retry(f.userId, f.vaultId, input.reply_id, Uuid.make(randomUUID())),
            ),
          )._tag,
        ).toBe("BadRequest");
      }),
    ),
  );

  it("reuses a completed conversation's creation key without duplicating its header", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const first = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, first);
        yield* f.finalize(first.reply_id);
        const next = command({ session: first.session });
        expect((yield* f.admission.accept(f.userId, f.vaultId, next)).session_id).toBe(
          response.session_id,
        );
        expect(decodeRequest((yield* f.reply(next.reply_id)).request).header).toBeNull();
        expect(
          (yield* f.histories.read(f.address(response.session_id)))!.history.records.filter(
            (record) => record.type === "conversation",
          ),
        ).toHaveLength(1);
      }),
    ));

  it("fixes the annotation target separately from the inherited context cutoff", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const first = command();
        const parent = yield* f.admission.accept(f.userId, f.vaultId, first);
        yield* f.finalize(first.reply_id);
        const second = followUp(parent.session_id);
        yield* f.admission.accept(f.userId, f.vaultId, second);
        yield* f.finalize(second.reply_id);
        const input = answerThread(parent.session_id, first.exchange_id);
        const child = yield* f.admission.reserve(f.userId, f.vaultId, input);
        const original = decodeRequest((yield* f.reply(input.reply_id)).request);
        expect(original.header).toMatchObject({
          anchor_reply_id: first.reply_id,
          context: { session_id: parent.session_id, reply_id: second.reply_id },
        });
        const third = followUp(parent.session_id);
        yield* f.admission.accept(f.userId, f.vaultId, third);
        yield* f.finalize(third.reply_id);
        yield* f.admission.admit(input.reply_id);
        expect((yield* f.histories.read(f.address(child.session_id)))!.history.header).toEqual({
          ...original.header,
          seq: 1,
        });
      }),
    ));

  it("rejects other owners, missing answers and nested BTW origins without reserving a child", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = btwCommand();
        const parent = yield* f.admission.accept(f.userId, f.vaultId, input);
        yield* f.finalize(input.reply_id);
        expect(
          failure(
            yield* Effect.exit(
              f.admission.reserve(
                f.userId,
                f.vaultId,
                answerThread(parent.session_id, input.exchange_id),
              ),
            ),
          )._tag,
        ).toBe("BadRequest");
        yield* f.db.query((client) =>
          client
            .update(sessions)
            .set({ kind: "session" })
            .where(and(eq(sessions.id, parent.session_id), eq(sessions.vaultId, f.vaultId))),
        );
        expect(
          failure(
            yield* Effect.exit(
              f.admission.reserve(
                f.memberId,
                f.vaultId,
                answerThread(parent.session_id, input.exchange_id),
              ),
            ),
          )._tag,
        ).toBe("NotFound");
        expect(
          failure(
            yield* Effect.exit(
              f.admission.reserve(
                f.userId,
                f.vaultId,
                answerThread(parent.session_id, Uuid.make(randomUUID())),
              ),
            ),
          )._tag,
        ).toBe("BadRequest");
        expect(yield* f.allSessions()).toHaveLength(1);
      }),
    ));

  it("does not silently skip a settled parent whose retained context is missing", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, input);
        yield* f.finalize(input.reply_id, {
          status: "stopped",
          generation: null,
          context_messages: null,
        });
        expect(
          failure(
            yield* Effect.exit(
              f.admission.reserve(f.userId, f.vaultId, followUp(response.session_id)),
            ),
          )._tag,
        ).toBe("BadRequest");
        expect(yield* f.allReplies()).toHaveLength(1);
      }),
    ));

  it("refuses an existing conversation with missing acknowledged history", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, input);
        yield* f.finalize(input.reply_id);
        yield* Effect.promise(() => unlink(join(f.directory, f.key(response.session_id))));
        const next = followUp(response.session_id);
        expect(
          failure(yield* Effect.exit(f.admission.reserve(f.userId, f.vaultId, next)))._tag,
        ).toBe("HistoryInvalid");
        expect(yield* f.reply(next.reply_id)).toBeUndefined();
      }),
    ));

  it("does not overwrite a later receipt when admission DB publication has an older snapshot", () =>
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
              yield* f.db.query((client) =>
                client
                  .update(sessions)
                  .set({
                    historySeq: advanced.history.revision.last_seq,
                    historySha256: advanced.history.revision.sha256,
                  })
                  .where(
                    and(eq(sessions.id, response.session_id), eq(sessions.vaultId, f.vaultId)),
                  ),
              );
              return committed;
            }),
        };
        expect(
          failure(yield* Effect.exit(f.coordinator({ histories }).admit(input.reply_id)))._tag,
        ).toBe("HistoryInvalid");
        expect((yield* f.reply(input.reply_id)).status).toBe("admitting");
        expect((yield* f.session(response.session_id)).historySeq).toBe(3);
      }),
    ));

  it("rejects malformed, mismatched and changing stored admission descriptors", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.reserve(f.userId, f.vaultId, input);
        const original = (yield* f.reply(input.reply_id)).request;
        yield* f.db.query((client) =>
          client.update(replies).set({ request: {} }).where(eq(replies.id, input.reply_id)),
        );
        expect(failure(yield* Effect.exit(f.admission.admit(input.reply_id)))).toMatchObject({
          _tag: "ReplyAdmissionInvalid",
          reason: "request_payload",
        });
        const mismatched = {
          ...decodeRequest(original),
          attempt: { ...decodeRequest(original).attempt, reply_id: Uuid.make(randomUUID()) },
        };
        yield* f.db.query((client) =>
          client.update(replies).set({ request: mismatched }).where(eq(replies.id, input.reply_id)),
        );
        expect(failure(yield* Effect.exit(f.admission.admit(input.reply_id)))).toMatchObject({
          _tag: "ReplyAdmissionInvalid",
          reason: "request_identity",
        });
        expect(yield* f.histories.read(f.address(response.session_id))).toBeNull();
        yield* f.db.query((client) =>
          client.update(replies).set({ request: original }).where(eq(replies.id, input.reply_id)),
        );
        const histories: HistoryStoreShape = {
          ...f.histories,
          commit: (...args) =>
            Effect.gen(function* () {
              const committed = yield* f.histories.commit(...args);
              yield* f.db.query((client) =>
                client
                  .update(replies)
                  .set({ request: { ...decodeRequest(original), mode: "btw" } })
                  .where(eq(replies.id, input.reply_id)),
              );
              return committed;
            }),
        };
        expect(
          failure(yield* Effect.exit(f.coordinator({ histories }).admit(input.reply_id))),
        ).toMatchObject({ _tag: "ReplyAdmissionInvalid" });
        expect((yield* f.reply(input.reply_id)).status).toBe("admitting");
      }),
    ));

  it("does not report acceptance after the reserved reply disappears before admission", () =>
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
        expect(
          failure(yield* Effect.exit(f.coordinator({ db }).accept(f.userId, f.vaultId, input)))
            ._tag,
        ).toBe("NotFound");
        expect(yield* f.reply(input.reply_id)).toBeUndefined();
        const [session] = yield* f.allSessions();
        expect(yield* f.histories.read(f.address(session.id))).toBeNull();
      }),
    ));

  it("does not make an admitting operation runnable when history already contains its settlement", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.reserve(f.userId, f.vaultId, input);
        const request = decodeRequest((yield* f.reply(input.reply_id)).request);
        expect(request.header).not.toBeNull();
        yield* f.histories.commit(f.address(response.session_id), [
          request.header!,
          request.attempt,
          settlement({ reply_id: input.reply_id }),
        ]);
        expect(failure(yield* Effect.exit(f.admission.admit(input.reply_id)))).toMatchObject({
          _tag: "ReplyAdmissionInvalid",
          reason: "settled_attempt",
        });
        expect((yield* f.reply(input.reply_id)).status).toBe("admitting");
        expect((yield* f.session(response.session_id)).historySeq).toBeNull();
      }),
    ));

  it("recognizes a concurrent admission that has already progressed through settlement", () =>
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

  it("blocks a new reservation when an acknowledged attempt has no operation or settlement", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, input);
        yield* f.db.query((client) => client.delete(replies).where(eq(replies.id, input.reply_id)));
        const next = followUp(response.session_id);
        expect(
          failure(yield* Effect.exit(f.admission.reserve(f.userId, f.vaultId, next)))._tag,
        ).toBe("Conflict");
        expect(yield* f.reply(next.reply_id)).toBeUndefined();
      }),
    ));

  it("rejects an unacknowledged history suffix without reserving or rewriting it", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.accept(f.userId, f.vaultId, input);
        yield* f.finalize(input.reply_id);
        const extra = Uuid.make(randomUUID());
        yield* f.histories.commit(f.address(response.session_id), [
          {
            type: "attempt",
            reply_id: extra,
            exchange_id: Uuid.make(randomUUID()),
            previous_attempt_id: null,
            parent_reply_id: input.reply_id,
            question: "Unacknowledged",
            accepted_at: timestamp,
          },
        ]);
        const bytes = yield* f.objects.getVersioned(f.key(response.session_id));
        expect(
          failure(
            yield* Effect.exit(
              f.admission.reserve(f.userId, f.vaultId, followUp(response.session_id)),
            ),
          )._tag,
        ).toBe("Conflict");
        expect(yield* f.objects.getVersioned(f.key(response.session_id))).toEqual(bytes);
        expect(yield* f.allReplies()).toHaveLength(1);
      }),
    ));

  it("allows a separate answer thread while its parent's later exchange is running", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const first = command();
        const parent = yield* f.admission.accept(f.userId, f.vaultId, first);
        yield* f.finalize(first.reply_id);
        const pending = followUp(parent.session_id);
        yield* f.admission.accept(f.userId, f.vaultId, pending);
        const child = answerThread(parent.session_id, first.exchange_id);
        yield* f.admission.accept(f.userId, f.vaultId, child);
        expect(decodeRequest((yield* f.reply(child.reply_id)).request).header).toMatchObject({
          anchor_reply_id: first.reply_id,
          context: { session_id: parent.session_id, reply_id: first.reply_id },
        });
        expect((yield* f.reply(pending.reply_id)).status).toBe("running");
        expect((yield* f.reply(child.reply_id)).status).toBe("running");
      }),
    ));

  it.each([
    ["unknown version", (request: AcceptedReplyRequest) => ({ ...request, version: 2 })],
    ["unknown fields", (request: AcceptedReplyRequest) => ({ ...request, extra: true })],
    [
      "missing native acceptance time",
      (request: AcceptedReplyRequest) => ({
        ...request,
        attempt: { ...request.attempt, accepted_at: null },
      }),
    ],
    ["missing frozen mode", (request: AcceptedReplyRequest) => ({ ...request, mode: null })],
    [
      "different creation origin",
      (request: AcceptedReplyRequest) => ({
        ...request,
        header: { ...request.header!, origin: documentOrigin },
      }),
    ],
    [
      "different author",
      (request: AcceptedReplyRequest) => ({
        ...request,
        header: { ...request.header!, author_id: Uuid.make(randomUUID()) },
      }),
    ],
    [
      "parent on a first attempt",
      (request: AcceptedReplyRequest) => ({
        ...request,
        attempt: { ...request.attempt, parent_reply_id: Uuid.make(randomUUID()) },
      }),
    ],
    [
      "predecessor on a first attempt",
      (request: AcceptedReplyRequest) => ({
        ...request,
        attempt: { ...request.attempt, previous_attempt_id: Uuid.make(randomUUID()) },
      }),
    ],
  ] as const)("rejects a stored descriptor with %s before writing history", (_name, change) =>
    withAdmission((f) =>
      Effect.gen(function* () {
        const input = command();
        const response = yield* f.admission.reserve(f.userId, f.vaultId, input);
        const request = decodeRequest((yield* f.reply(input.reply_id)).request);
        yield* f.db.query((client) =>
          client
            .update(replies)
            .set({ request: change(request) })
            .where(eq(replies.id, input.reply_id)),
        );
        expect(failure(yield* Effect.exit(f.admission.admit(input.reply_id)))._tag).toBe(
          "ReplyAdmissionInvalid",
        );
        expect(yield* f.histories.read(f.address(response.session_id))).toBeNull();
        expect((yield* f.reply(input.reply_id)).status).toBe("admitting");
      }),
    ),
  );

  it("does not admit missing or terminal operations again", () =>
    withAdmission((f) =>
      Effect.gen(function* () {
        expect(yield* f.admission.admit(Uuid.make(randomUUID()))).toBe(false);
        const input = command();
        yield* f.admission.accept(f.userId, f.vaultId, input);
        yield* f.finalize(input.reply_id);
        const terminal = yield* f.reply(input.reply_id);
        expect(yield* f.admission.admit(input.reply_id)).toBe(false);
        expect(yield* f.reply(input.reply_id)).toEqual(terminal);
        expect(yield* acceptedRequestFor(terminal)).toEqual(decodeRequest(terminal.request));
      }),
    ));
});
