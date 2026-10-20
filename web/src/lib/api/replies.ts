import {
  ReplySnapshot,
  isReplyPending,
  type CreateReplyRequest,
  type CreateReplyResponse,
  type Uuid,
} from "@great-minds/domain";
import { Stream } from "effect";

import { api, run, stream } from "./app";
import { selectedVault } from "./selected-vault";
import { followSnapshots } from "./sse";

export type CreateReplyPayload = CreateReplyRequest;
export type { CreateReplyResponse, ReplySnapshot };

export function createReply(
  payload: CreateReplyPayload,
  signal?: AbortSignal,
): Promise<CreateReplyResponse> {
  return run(api.replies.createReply({ params: { vault_id: selectedVault() }, payload }), {
    signal,
  });
}

export function retryReply(
  replyId: Uuid,
  nextReplyId: Uuid,
  signal?: AbortSignal,
): Promise<CreateReplyResponse> {
  return run(
    api.replies.retryReply({
      params: { vault_id: selectedVault(), reply_id: replyId },
      payload: { reply_id: nextReplyId },
    }),
    { signal },
  );
}

export function stopReply(replyId: Uuid, signal?: AbortSignal): Promise<void> {
  return run(api.replies.stopReply({ params: { vault_id: selectedVault(), reply_id: replyId } }), {
    signal,
  });
}

export function streamReply(replyId: Uuid, signal?: AbortSignal): AsyncIterable<ReplySnapshot> {
  return stream(
    followSnapshots(
      Stream.unwrap(
        api.replies.streamReply({ params: { vault_id: selectedVault(), reply_id: replyId } }),
      ),
      ReplySnapshot,
      (snapshot) => !isReplyPending(snapshot.status),
    ),
    signal,
  );
}
