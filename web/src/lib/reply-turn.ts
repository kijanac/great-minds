import type { ReplySnapshot } from "@great-minds/domain";

export const replyTurn = (snapshot: ReplySnapshot, alwaysShowThinking = false) => ({
  answer: snapshot.answer,
  thinking:
    snapshot.sources.length > 0 || alwaysShowThinking ? [{ sources: snapshot.sources }] : [],
  streaming: snapshot.status === "running",
  error: snapshot.error,
});
