import { randomBytes, randomUUID } from "node:crypto";

import {
  Database,
  replies,
  sessions,
  users,
  vaultMemberships,
  vaults,
} from "@great-minds/database";
import { CreateReplyRequest, type SessionId, Uuid } from "@great-minds/domain";
import { and, eq } from "drizzle-orm";
import { Effect, Schema, type Scope } from "effect";

import type { ClockService } from "../../src/clock.ts";
import { makeReplyAdmission } from "../../src/conversation-history/admission.ts";
import {
  makeReplySettlement,
  type ReplySettlementResult,
} from "../../src/conversation-history/settlement.ts";
import { makeHistoryStore, type HistoryStoreShape } from "../../src/conversation-history/store.ts";
import { openLocalConditionalObjectStore } from "../../src/storage/local-conditional-object-store.ts";
import { VaultAccessService, VaultAccessServiceLive } from "../../src/vaults.ts";
import { timestamp } from "./conversation-history.ts";
import { temporaryDirectory } from "./history-storage.ts";
import { runHistoryDatabase } from "./reply-history-database.ts";
import { completion } from "./reply-settlement.ts";

export const command = (overrides: Partial<CreateReplyRequest> = {}): CreateReplyRequest =>
  Schema.decodeUnknownSync(CreateReplyRequest)({
    reply_id: randomUUID(),
    exchange_id: randomUUID(),
    question: "A durable question. é 漢字",
    session: { kind: "new", idempotency_key: randomUUID() },
    ...overrides,
  });

const setup = Effect.gen(function* () {
  const db = yield* Database;
  const access = yield* VaultAccessService;
  const directory = yield* temporaryDirectory;
  const objects = yield* openLocalConditionalObjectStore(directory);
  const histories = makeHistoryStore(objects);
  const userId = Uuid.make(randomUUID());
  const memberId = Uuid.make(randomUUID());
  const outsiderId = Uuid.make(randomUUID());
  const vaultId = Uuid.make(randomUUID());
  let now = new Date(timestamp);
  const clock = {
    now: Effect.sync(() => new Date(now.getTime())),
  } satisfies ClockService["Service"];
  const random = { bytes: (size: number) => Effect.sync(() => new Uint8Array(randomBytes(size))) };

  yield* Effect.acquireRelease(
    db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .insert(users)
          .values(
            [userId, memberId, outsiderId].map((id) => ({ id, email: `${id}@reply-history.test` })),
          );
        yield* tx
          .insert(vaults)
          .values({ id: vaultId, ownerId: userId, name: "Reply admission test" });
        yield* tx.insert(vaultMemberships).values([
          { id: Uuid.make(randomUUID()), vaultId, userId, role: "OWNER" },
          { id: Uuid.make(randomUUID()), vaultId, userId: memberId, role: "EDITOR" },
        ]);
      }),
    ),
    () =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          for (const id of [userId, memberId, outsiderId])
            yield* tx.delete(users).where(eq(users.id, id));
        }),
      ),
  );
  const coordinator = (
    options: { db?: Database["Service"]; histories?: HistoryStoreShape; configured?: boolean } = {},
  ) =>
    makeReplyAdmission(
      options.db ?? db,
      options.histories ?? histories,
      clock,
      random,
      access,
      options.configured ?? true,
    );
  const address = (sessionId: SessionId) => ({ vault_id: vaultId, session_id: sessionId });
  const key = (sessionId: SessionId) => `vaults/${vaultId}/sessions/${sessionId}.jsonl`;
  const finalize = (replyId: Uuid, result: ReplySettlementResult = completion()) =>
    Effect.gen(function* () {
      const finalizer = makeReplySettlement(db, histories, clock);
      yield* finalizer.begin(replyId, result);
      yield* finalizer.publish(replyId);
    });

  return {
    db,
    directory,
    objects,
    histories,
    clock,
    userId,
    memberId,
    outsiderId,
    vaultId,
    coordinator,
    admission: coordinator(),
    address,
    key,
    finalize,
    setTime: (value: Date) => {
      now = value;
    },
    reply: (replyId: Uuid) =>
      db
        .query((client) => client.select().from(replies).where(eq(replies.id, replyId)))
        .pipe(Effect.map((rows) => rows[0])),
    session: (sessionId: SessionId) =>
      db
        .query((client) =>
          client
            .select()
            .from(sessions)
            .where(and(eq(sessions.id, sessionId), eq(sessions.vaultId, vaultId))),
        )
        .pipe(Effect.map((rows) => rows[0])),
    allReplies: () =>
      db.query((client) => client.select().from(replies).where(eq(replies.vaultId, vaultId))),
    allSessions: () =>
      db.query((client) => client.select().from(sessions).where(eq(sessions.vaultId, vaultId))),
  };
});

export type ReplyAdmissionFixture = Effect.Success<typeof setup>;

export const withAdmission = <Value, Error>(
  use: (fixture: ReplyAdmissionFixture) => Effect.Effect<Value, Error, Scope.Scope>,
) =>
  runHistoryDatabase(
    Effect.gen(function* () {
      return yield* use(yield* setup.pipe(Effect.provide(VaultAccessServiceLive)));
    }),
  );
