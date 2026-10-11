import { randomUUID } from "node:crypto";

import { Database, replies, sessions, users, vaults } from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { and, eq } from "drizzle-orm";
import { Effect, type Scope } from "effect";

import type { ClockService } from "../../src/clock.ts";
import {
  makeReplySettlement,
  type ReplySettlementResult,
} from "../../src/conversation-history/settlement.ts";
import { makeHistoryStore } from "../../src/conversation-history/store.ts";
import { openLocalConditionalObjectStore } from "../../src/storage/local-conditional-object-store.ts";
import { attempt, header, sessionId, settlement, timestamp } from "./conversation-history.ts";
import { temporaryDirectory } from "./history-storage.ts";
import { runHistoryDatabase } from "./reply-history-database.ts";

export const completion = (): Extract<ReplySettlementResult, { status: "completed" }> => {
  const result = settlement();
  if (result.generation === null || result.context_messages === null) {
    throw new Error("The completed-result fixture must have generation metadata and context");
  }
  return {
    status: "completed",
    answer: result.answer,
    sources: result.sources,
    context_messages: result.context_messages,
    generation: result.generation,
  };
};

const setup = Effect.gen(function* () {
  const db = yield* Database;
  const directory = yield* temporaryDirectory;
  const objects = yield* openLocalConditionalObjectStore(directory);
  const histories = makeHistoryStore(objects);
  const userId = Uuid.make(randomUUID());
  const vaultId = Uuid.make(randomUUID());
  const replyId = Uuid.make(randomUUID());
  const address = { vault_id: vaultId, session_id: sessionId };
  const key = `vaults/${vaultId}/sessions/${sessionId}.jsonl`;
  const accepted = attempt({ reply_id: replyId });
  const initial = [header({ author_id: userId }), accepted];
  const admission = yield* histories.commit(address, initial);
  let now = new Date(timestamp);
  const clock = {
    now: Effect.sync(() => new Date(now.getTime())),
  } satisfies ClockService["Service"];
  const progress = {
    answer: "Visible partial. é 漢字",
    sources: [
      { ...completion().sources[0], pending: false },
      { ...completion().sources[0], label: "Pending tool", pending: true },
    ],
  };

  yield* Effect.acquireRelease(
    db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.insert(users).values({ id: userId, email: `${userId}@reply-history.test` });
        yield* tx
          .insert(vaults)
          .values({ id: vaultId, ownerId: userId, name: "Reply settlement test" });
        yield* tx.insert(sessions).values({
          id: sessionId,
          vaultId,
          userId,
          query: accepted.question,
          createdAt: now,
          updatedAt: now,
          historySeq: admission.history.revision.last_seq,
          historySha256: admission.history.revision.sha256,
        });
        yield* tx.insert(replies).values({
          id: replyId,
          vaultId,
          userId,
          sessionId,
          kind: "exchange",
          status: "running",
          ...progress,
          request: {
            reply_id: replyId,
            exchange_id: accepted.exchange_id,
            question: accepted.question,
            mode: "btw",
            origin_scope: "vault",
            session: { kind: "existing", id: sessionId },
          },
          activeGenerationStep: 1,
          activeGenerationKind: "model",
          activeGenerationKey: "model-attempt-1",
          createdAt: now,
          updatedAt: now,
        });
      }),
    ),
    () => db.query((client) => client.delete(users).where(eq(users.id, userId))),
  );

  return {
    db,
    directory,
    objects,
    histories,
    clock,
    userId,
    vaultId,
    replyId,
    address,
    key,
    initial,
    admission,
    progress,
    finalizer: makeReplySettlement(db, histories, clock),
    setTime: (value: Date) => {
      now = value;
    },
    reply: () =>
      db
        .query((client) => client.select().from(replies).where(eq(replies.id, replyId)))
        .pipe(Effect.map((rows) => rows[0])),
    session: () =>
      db
        .query((client) =>
          client
            .select()
            .from(sessions)
            .where(and(eq(sessions.id, sessionId), eq(sessions.vaultId, vaultId))),
        )
        .pipe(Effect.map((rows) => rows[0])),
  };
});

export type ReplySettlementFixture = Effect.Success<typeof setup>;

export const withSettlement = <Value, Error>(
  use: (fixture: ReplySettlementFixture) => Effect.Effect<Value, Error, Scope.Scope>,
) =>
  runHistoryDatabase(
    Effect.gen(function* () {
      return yield* use(yield* setup);
    }),
  );
