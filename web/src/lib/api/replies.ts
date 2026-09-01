import {
  CreateReplyRequest,
  ReplySnapshot,
  Uuid,
  type CreateReplyResponse,
} from "@great-minds/domain";
import { Filter, Option, Schema, Stream } from "effect";
import type * as Sse from "effect/unstable/encoding/Sse";

import { getVaultId } from "../vault-selection";

import { api, run, stream } from "./app";
import { followUntil } from "./sse";

export type CreateReplyPayload = typeof CreateReplyRequest.Encoded;
export type { CreateReplyResponse, ReplySnapshot };

type ReplyEvent =
  | { readonly _tag: "Snapshot"; readonly snapshot: ReplySnapshot }
  | { readonly _tag: "Done" };

const uuid = Schema.decodeSync(Uuid);
const decodeCreate = Schema.decodeSync(Schema.fromJsonString(CreateReplyRequest));
const snapshotFromJson = Schema.decodeOption(Schema.fromJsonString(ReplySnapshot));

function selectedVault(): Uuid {
  const id = getVaultId();
  if (id === null) throw new Error("No vault selected");
  return uuid(id);
}

const createReplyRequest = (payload: CreateReplyRequest) => {
  const params = { vault_id: selectedVault() };
  switch (payload.kind) {
    case "btw":
      return api.replies.createReply({ params, payload });
    case "ephemeral":
      return api.replies.createReply({ params, payload });
    case "exchange":
      return "session_id" in payload
        ? api.replies.createReply({ params, payload })
        : api.replies.createReply({ params, payload });
  }
};

export function createReply(
  payload: CreateReplyPayload,
  signal?: AbortSignal,
): Promise<CreateReplyResponse> {
  return run(createReplyRequest(decodeCreate(JSON.stringify(payload))), { signal });
}

export function retryReply(
  replyId: string,
  nextReplyId: string,
  signal?: AbortSignal,
): Promise<CreateReplyResponse> {
  return run(
    api.replies.retryReply({
      params: { vault_id: selectedVault(), reply_id: uuid(replyId) },
      payload: { reply_id: uuid(nextReplyId) },
    }),
    { signal },
  );
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

export function streamReply(replyId: string, signal?: AbortSignal): AsyncIterable<ReplySnapshot> {
  const events = Stream.unwrap(
    api.replies.streamReply({ params: { vault_id: selectedVault(), reply_id: uuid(replyId) } }),
  ).pipe(Stream.filterMap(Filter.fromPredicateOption(toReplyEvent)));
  const snapshots = followUntil(events, isTerminal).pipe(
    Stream.filterMap(Filter.fromPredicateOption(snapshotOf)),
    Stream.changesWith((previous, next) => previous.version === next.version),
  );
  return stream(snapshots, signal);
}
