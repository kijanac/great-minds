import { isReplyPending, type ReplySnapshot, type SessionActivity } from "@great-minds/domain";
import type { Exchange } from "#lib/types.ts";

export const applyReplySnapshot = (
  exchange: Exchange,
  snapshot: ReplySnapshot,
): { exchange: Exchange; activity: SessionActivity | null } | null => {
  if (
    snapshot.reply_id !== exchange.replyId ||
    (exchange.version !== null && snapshot.version <= exchange.version)
  )
    return null;
  const recorded = exchange.status !== "running";
  const pending = isReplyPending(snapshot.status);
  return {
    exchange: recorded
      ? { ...exchange, version: snapshot.version }
      : {
          ...exchange,
          answer: snapshot.answer,
          citations: snapshot.citations,
          sources: snapshot.sources,
          startedAt: snapshot.created_at,
          status: pending ? "running" : snapshot.status,
          error: snapshot.error,
          version: snapshot.version,
        },
    activity: pending
      ? { reply_id: snapshot.reply_id, status: recorded ? "settling" : snapshot.status }
      : null,
  };
};
