import type { SessionActivity, SessionId, Uuid } from "@great-minds/domain";

import { streamReply } from "$lib/api/replies";
import { applyReplySnapshot, replyActivity } from "$lib/reply-turn";
import type { Exchange } from "$lib/types";
import { isAbortError } from "$lib/utils";

export const LIVE_UPDATES_UNAVAILABLE =
  "Live updates are unavailable. Reconnect to check this response.";

export interface ReplyTailOwner {
  readonly conversationId: () => SessionId | null;
  readonly turn: () => Exchange | undefined;
  readonly apply: (updated: Exchange, activity: SessionActivity | null) => void;
  readonly alwaysShowThinking?: boolean;
}

export const tailReply = async (
  replyId: Uuid,
  signal: AbortSignal,
  owner: ReplyTailOwner,
): Promise<"ended" | "abandoned"> => {
  try {
    for await (const snapshot of streamReply(replyId, signal)) {
      if (signal.aborted || snapshot.session_id !== owner.conversationId()) return "abandoned";
      const current = owner.turn();
      if (current?.replyId !== replyId) return "abandoned";
      const updated = applyReplySnapshot(current, snapshot, owner.alwaysShowThinking);
      if (updated === null) continue;
      owner.apply(updated, replyActivity(snapshot, updated));
    }
  } catch (error) {
    if (isAbortError(error) || signal.aborted) return "abandoned";
    console.error("Failed to resume reply:", error);
  }
  return signal.aborted ? "abandoned" : "ended";
};
