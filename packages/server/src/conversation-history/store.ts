import type { SessionId, Uuid } from "@great-minds/domain";
import { Context, Effect, Result } from "effect";

import type {
  ConditionalObjectStore,
  ObjectVersionConflict,
  StorageBackendError,
} from "../storage/object-store.ts";
import type { HistoryWrite } from "./schema.ts";
import {
  type ConversationHistory,
  type HistoryConflict,
  HistoryInvalid,
  type HistoryRevision,
  parseHistory,
  planHistoryAppend,
  verifyHistoryReceipt,
} from "./history.ts";

export type HistoryAddress = {
  readonly vault_id: Uuid;
  readonly session_id: SessionId;
};

export type HistoryFile = {
  readonly history: ConversationHistory;
  readonly version: string;
};

export type HistoryCommitError =
  | HistoryInvalid
  | HistoryConflict
  | ObjectVersionConflict
  | StorageBackendError;

export interface HistoryStoreShape {
  readonly read: (
    address: HistoryAddress,
    receipt?: HistoryRevision,
  ) => Effect.Effect<HistoryFile | null, HistoryInvalid | StorageBackendError>;
  readonly commit: (
    address: HistoryAddress,
    writes: readonly HistoryWrite[],
    receipt?: HistoryRevision,
  ) => Effect.Effect<
    {
      readonly history: ConversationHistory;
      readonly written: boolean;
    },
    HistoryCommitError
  >;
}

export class HistoryStore extends Context.Service<HistoryStore, HistoryStoreShape>()(
  "@great-minds/server/HistoryStore",
) {}

const objectKey = (address: HistoryAddress) =>
  `vaults/${address.vault_id}/sessions/${address.session_id}.jsonl`;

export const makeHistoryStore = (objects: ConditionalObjectStore): HistoryStoreShape => {
  const read = (address: HistoryAddress, receipt?: HistoryRevision) =>
    Effect.gen(function* () {
      const object = yield* objects
        .getVersioned(objectKey(address))
        .pipe(Effect.catchTag("ObjectMissing", () => Effect.succeed(null)));
      if (object === null) {
        if (receipt !== undefined) {
          return yield* new HistoryInvalid({
            session_id: address.session_id,
            line: null,
            reason: "history_receipt",
          });
        }
        return null;
      }
      const parsed = parseHistory(address.session_id, object.bytes);
      if (Result.isFailure(parsed)) return yield* parsed.failure;
      if (receipt !== undefined) {
        const checked = verifyHistoryReceipt(parsed.success, receipt);
        if (Result.isFailure(checked)) return yield* checked.failure;
      }
      return { history: parsed.success, version: object.version };
    });

  const commit = (
    address: HistoryAddress,
    writes: readonly HistoryWrite[],
    receipt?: HistoryRevision,
  ) =>
    Effect.gen(function* () {
      const current = yield* read(address, receipt);
      const planned = planHistoryAppend(address.session_id, current?.history ?? null, writes);
      if (Result.isFailure(planned)) return yield* planned.failure;
      const { history, changed } = planned.success;
      if (!changed) return { history, written: false };
      return yield* objects
        .putIfVersion(
          objectKey(address),
          current?.version ?? null,
          new TextEncoder().encode(history.jsonl),
        )
        .pipe(
          Effect.as({ history, written: true }),
          Effect.catchTag("ObjectVersionConflict", (conflict) =>
            Effect.gen(function* () {
              const latest = yield* read(address, receipt);
              if (latest !== null) {
                const replay = planHistoryAppend(address.session_id, latest.history, writes);
                if (Result.isSuccess(replay) && !replay.success.changed)
                  return { history: latest.history, written: false };
              }
              return yield* conflict;
            }),
          ),
        );
    });

  return { read, commit } satisfies HistoryStoreShape;
};
