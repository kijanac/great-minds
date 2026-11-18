import { type Database, type TransactionClient, replies, sessions } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { HistoryInvalid, type HistoryRevision } from "./history.ts";

export type SessionRow = typeof sessions.$inferSelect;
export type ReplyRow = typeof replies.$inferSelect;

export const sessionReceipt = (
  session: Pick<SessionRow, "historySeq" | "historySha256">,
): HistoryRevision | undefined =>
  session.historySeq === null || session.historySha256 === null
    ? undefined
    : { last_seq: session.historySeq, sha256: session.historySha256 };

export const acknowledgedReceipt = (
  session: Pick<SessionRow, "id" | "historySeq" | "historySha256">,
) => {
  const receipt = sessionReceipt(session);
  return receipt === undefined
    ? Effect.fail(
        new HistoryInvalid({ session_id: session.id, line: null, reason: "history_receipt" }),
      )
    : Effect.succeed(receipt);
};

export const readReplyOperation = (db: Database["Service"], replyId: Uuid) =>
  db
    .query((client) =>
      client
        .select({ reply: replies, session: sessions })
        .from(replies)
        .innerJoin(
          sessions,
          and(eq(sessions.id, replies.sessionId), eq(sessions.vaultId, replies.vaultId)),
        )
        .where(eq(replies.id, replyId))
        .limit(1),
    )
    .pipe(Effect.map((rows) => rows[0]));

export const lockReplyOperation = (
  tx: TransactionClient,
  identity: Pick<ReplyRow, "id" | "sessionId" | "vaultId">,
) =>
  Effect.gen(function* () {
    const [session] = yield* tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, identity.sessionId), eq(sessions.vaultId, identity.vaultId)))
      .limit(1)
      .for("update");
    if (session === undefined) return null;
    const [reply] = yield* tx
      .select()
      .from(replies)
      .where(
        and(
          eq(replies.id, identity.id),
          eq(replies.sessionId, identity.sessionId),
          eq(replies.vaultId, identity.vaultId),
        ),
      )
      .limit(1)
      .for("update");
    return reply === undefined ? null : { session, reply };
  });
