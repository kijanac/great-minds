import { writeFile } from "node:fs/promises";
import {
  CreateReplyRequest,
  type CreateReplyResponse,
  type SessionId,
  SessionOrigin,
  ThinkingBlock,
  Uuid,
} from "@great-minds/domain";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";

import { ClockLive } from "../src/clock.ts";
import { AppConfigLive } from "../src/config.ts";
import { DrizzleLive } from "../src/db.ts";
import { StructuredLoggerLive } from "../src/logging.ts";
import { RandomBytesLive } from "../src/random.ts";
import { sourceIdForKey } from "../src/source-identity.ts";
import { HistoryStoreLive, StorageServicesLive } from "../src/storage.ts";
import { VaultAccessServiceLive } from "../src/vaults.ts";
import { seedConversationReply } from "./lib/seed-conversation.ts";

const SeedExchange = Schema.Struct({
  id: Uuid,
  query: Schema.String,
  thinking: Schema.Array(ThinkingBlock).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  answer: Schema.String,
});
const SeedBtwTurn = Schema.Struct({
  query: Schema.String,
  thinking: Schema.Array(ThinkingBlock).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  answer: Schema.String.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(""))),
});
const SeedBtw = Schema.Struct({
  quote: Schema.String,
  blockOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  context: Schema.String.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(""))),
  exchangeId: Uuid,
  exchanges: Schema.Array(SeedBtwTurn),
});
const SeedSpec = Schema.Struct({
  user_id: Uuid,
  vault_id: Uuid,
  sessions: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      idempotency_key: Schema.String,
      exchange: SeedExchange,
      origin: Schema.optionalKey(SessionOrigin),
      btws: Schema.optionalKey(Schema.Array(SeedBtw)),
      follow_ups: Schema.optionalKey(Schema.Array(SeedExchange)),
    }),
  ),
});
const readStdin = async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};
const outputPath = process.argv[2];
if (outputPath === undefined)
  throw new Error("usage: seed-verification-sessions.ts <output-json-path> < spec.json");
const spec = Schema.decodeUnknownSync(SeedSpec)(JSON.parse(await readStdin()));
const BaseLive = Layer.mergeAll(
  DrizzleLive.pipe(Layer.provideMerge(AppConfigLive)),
  ClockLive,
  RandomBytesLive,
  StructuredLoggerLive,
);
const StorageLive = StorageServicesLive.pipe(Layer.provideMerge(BaseLive));
const SeedLive = Layer.mergeAll(
  HistoryStoreLive.pipe(Layer.provideMerge(StorageLive)),
  VaultAccessServiceLive.pipe(Layer.provideMerge(BaseLive)),
);
const runtime = ManagedRuntime.make(SeedLive);
try {
  const seeded = await runtime.runPromise(
    Effect.gen(function* () {
      const out: Record<string, SessionId> = {};
      const seed = (
        key: string,
        exchangeId: Uuid,
        turn: typeof SeedBtwTurn.Type,
        session: CreateReplyRequest["session"],
      ) =>
        seedConversationReply(
          spec.user_id,
          spec.vault_id,
          Schema.decodeUnknownSync(CreateReplyRequest)({
            reply_id: sourceIdForKey(spec.vault_id, `verification:${key}:${exchangeId}`),
            exchange_id: exchangeId,
            question: turn.query,
            model: "fixture/static",
            session,
          }),
          { answer: turn.answer, sources: turn.thinking.flatMap((block) => block.sources) },
        );
      for (const item of spec.sessions) {
        const root = yield* seed(item.idempotency_key, item.exchange.id, item.exchange, {
          kind: "new",
          idempotency_key: item.idempotency_key,
          conversation_kind: item.origin?.anchor ? "btw" : "session",
          origin_scope: "vault",
          ...(item.origin === undefined ? {} : { origin: item.origin }),
        });
        for (const exchange of item.follow_ups ?? []) {
          yield* seed(item.idempotency_key, exchange.id, exchange, {
            kind: "existing",
            id: root.session_id,
          });
        }
        const latestBtws = new Map<string, typeof SeedBtw.Type>();
        for (const btw of item.btws ?? [])
          latestBtws.set(`${btw.exchangeId}\0${btw.blockOffset}\0${btw.quote}`, btw);
        for (const btw of latestBtws.values()) {
          const key = `${item.idempotency_key}:btw:${btw.exchangeId}:${btw.blockOffset}:${btw.quote}`;
          let child: SessionId | null = null;
          for (const [index, turn] of btw.exchanges.entries()) {
            const response: CreateReplyResponse = yield* seed(
              key,
              sourceIdForKey(spec.vault_id, `${key}:${index}`),
              turn,
              child === null
                ? {
                    kind: "new",
                    idempotency_key: key,
                    conversation_kind: "btw",
                    origin_scope: "vault",
                    origin: {
                      kind: "answer",
                      session_id: root.session_id,
                      exchange_id: btw.exchangeId,
                      anchor: btw.quote,
                      paragraph_index: btw.blockOffset,
                      paragraph: btw.context,
                    },
                  }
                : { kind: "existing", id: child },
            );
            child = response.session_id;
          }
        }
        out[item.key] = root.session_id;
      }
      return out;
    }),
  );
  await writeFile(outputPath, `${JSON.stringify({ sessions: seeded }, null, 2)}\n`, "utf8");
} finally {
  await runtime.dispose();
}
