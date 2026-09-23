import {
  ReplySnapshot,
  type CreateReplyRequest,
  type CreateReplyResponse,
  type Uuid,
} from "@great-minds/domain";
import { Filter, Option, Schema, Stream } from "effect";
import type * as Sse from "effect/unstable/encoding/Sse";

import { api, run, stream } from "./app";
import { selectedVault } from "./selected-vault";
import { followUntil } from "./sse";

export type CreateReplyPayload = CreateReplyRequest;
export type { CreateReplyResponse, ReplySnapshot };

type ReplyEvent =
  | { readonly _tag: "Snapshot"; readonly snapshot: ReplySnapshot }
  | { readonly _tag: "Done" };

const snapshotFromJson = Schema.decodeOption(Schema.fromJsonString(ReplySnapshot));

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

const toReplyEvent = (event: Sse.EventEncoded): Option.Option<ReplyEvent> => {
  if (event.event === "done") return Option.some({ _tag: "Done" });
  if (event.event !== "message" || event.data.length === 0) return Option.none();
  return Option.map(snapshotFromJson(event.data), (snapshot) => ({ _tag: "Snapshot", snapshot }));
};

const isTerminal = (event: ReplyEvent) =>
  event._tag === "Done" || event.snapshot.status !== "running";

const snapshotOf = (event: ReplyEvent) =>
  event._tag === "Snapshot" ? Option.some(event.snapshot) : Option.none();

export function streamReply(replyId: Uuid, signal?: AbortSignal): AsyncIterable<ReplySnapshot> {
  const events = Stream.unwrap(
    api.replies.streamReply({ params: { vault_id: selectedVault(), reply_id: replyId } }),
  ).pipe(Stream.filterMap(Filter.fromPredicateOption(toReplyEvent)));
  const snapshots = followUntil(events, isTerminal).pipe(
    Stream.filterMap(Filter.fromPredicateOption(snapshotOf)),
    Stream.changesWith((previous, next) => previous.version === next.version),
  );
  return stream(snapshots, signal);
}
