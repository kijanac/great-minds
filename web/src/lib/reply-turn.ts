import { isReplyPending, type ReplySnapshot, type SessionActivity } from "@great-minds/domain";
import type { Exchange } from "$lib/types";

export const applyReplySnapshot = (
  exchange: Exchange,
  snapshot: ReplySnapshot,
  alwaysShowThinking = false,
): Exchange | null => {
  if (
    snapshot.reply_id !== exchange.replyId ||
    (exchange.version !== null && snapshot.version <= exchange.version)
  )
    return null;
  if (exchange.status !== "running") return { ...exchange, version: snapshot.version };
  return {
    ...exchange,
    answer: snapshot.answer,
    thinking:
      snapshot.sources.length > 0 || alwaysShowThinking ? [{ sources: snapshot.sources }] : [],
    status: isReplyPending(snapshot.status) ? "running" : snapshot.status,
    error: snapshot.error,
    version: snapshot.version,
  };
};

export const replyActivity = (
  snapshot: ReplySnapshot,
  exchange: Exchange,
): SessionActivity | null => {
  if (!isReplyPending(snapshot.status)) return null;
  return {
    reply_id: snapshot.reply_id,
    status: exchange.status === "running" ? snapshot.status : "settling",
  };
};
