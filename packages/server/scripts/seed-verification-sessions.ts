import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { Database, sessions } from "@great-minds/database";
import {
  composeAnchoredQuestion,
  type SessionId,
  SessionOrigin,
  ThinkingBlock,
  Uuid,
} from "@great-minds/domain";
import { and, eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";

import { ClockLive } from "../src/clock.ts";
import { AppConfigLive } from "../src/config.ts";
import { DrizzleLive } from "../src/db.ts";
import { IngestServiceLive } from "../src/ingest.ts";
import { StructuredLoggerLive } from "../src/logging.ts";
import { PipelineRunsServiceLive } from "../src/pipeline-runs.ts";
import { ProposalsServiceLive } from "../src/proposals.ts";
import { RandomBytesLive } from "../src/random.ts";
import { SessionsService, SessionsServiceLive } from "../src/sessions.ts";
import { SourceDocumentsServiceLive } from "../src/source-documents.ts";
import { StorageServicesLive } from "../src/storage.ts";
import { UserDocumentsServiceLive } from "../src/user-documents.ts";
import { VaultAccessServiceLive } from "../src/vaults.ts";

const SeedExchange = Schema.Struct({
  id: Uuid,
  query: Schema.String,
  thinking: Schema.Array(ThinkingBlock).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
  ),
  answer: Schema.String,
});

const SeedBtwTurn = Schema.Struct({
  query: Schema.String,
  thinking: Schema.Array(ThinkingBlock).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
  ),
  answer: Schema.String.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(""))),
});

const SeedBtw = Schema.Struct({
  quote: Schema.String,
  blockOffset: Schema.Number.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(-1))),
  context: Schema.String.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(""))),
  exchangeId: Uuid,
  exchanges: Schema.Array(SeedBtwTurn),
});

const SessionSpec = Schema.Struct({
  key: Schema.String,
  idempotency_key: Schema.String,
  exchange: SeedExchange,
  origin: Schema.optionalKey(SessionOrigin),
  btws: Schema.optionalKey(Schema.Array(SeedBtw)),
  follow_ups: Schema.optionalKey(Schema.Array(SeedExchange)),
});

const SeedSpec = Schema.Struct({
  user_id: Uuid,
  vault_id: Uuid,
  sessions: Schema.Array(SessionSpec),
});
const decodeSeedSpec = Schema.decodeUnknownSync(SeedSpec);
const decodeUuid = Schema.decodeUnknownSync(Uuid);

const newUuid = () => decodeUuid(randomUUID());

const sourcesForThinking = (thinking: readonly (typeof ThinkingBlock)["Type"][]) =>
  thinking.flatMap((block) => block.sources ?? []);

const readStdin = async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const outputPath = process.argv[2];
if (outputPath === undefined) {
  throw new Error("usage: seed-verification-sessions.ts <output-json-path> < spec.json");
}

const ConfigLive = AppConfigLive;
const DatabaseLive = DrizzleLive.pipe(Layer.provideMerge(ConfigLive));
const BaseLive = Layer.mergeAll(DatabaseLive, ClockLive, RandomBytesLive, StructuredLoggerLive);
const VaultAccessLive = VaultAccessServiceLive.pipe(Layer.provideMerge(BaseLive));
const StorageLive = StorageServicesLive.pipe(Layer.provideMerge(BaseLive));
const SourceDocumentsLive = SourceDocumentsServiceLive.pipe(
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(BaseLive),
);
const UserDocumentsLive = UserDocumentsServiceLive.pipe(
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(BaseLive),
);
const PipelineRunsLive = PipelineRunsServiceLive.pipe(Layer.provideMerge(BaseLive));
const ProposalsLive = ProposalsServiceLive.pipe(
  Layer.provideMerge(SourceDocumentsLive),
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(VaultAccessLive),
  Layer.provideMerge(BaseLive),
);
const IngestLive = IngestServiceLive.pipe(
  Layer.provideMerge(ProposalsLive),
  Layer.provideMerge(SourceDocumentsLive),
  Layer.provideMerge(UserDocumentsLive),
  Layer.provideMerge(PipelineRunsLive),
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(VaultAccessLive),
  Layer.provideMerge(BaseLive),
);
const SessionsLive = SessionsServiceLive.pipe(
  Layer.provideMerge(VaultAccessLive),
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(IngestLive),
  Layer.provideMerge(ProposalsLive),
  Layer.provideMerge(SourceDocumentsLive),
  Layer.provideMerge(BaseLive),
);

const spec = decodeSeedSpec(JSON.parse(await readStdin()));
const runtime = ManagedRuntime.make(SessionsLive);
const seeded = await runtime.runPromise(
  Effect.gen(function* () {
    const db = yield* Database;
    const service = yield* SessionsService;
    const out: Record<string, string> = {};
    for (const item of spec.sessions) {
      const existing = yield* db.query((d) => d
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.vaultId, spec.vault_id),
            eq(sessions.userId, spec.user_id),
            eq(sessions.idempotencyKey, item.idempotency_key),
          ),
        )
        .limit(1));
      const found = existing[0]?.id;
      if (found !== undefined) {
        out[item.key] = found;
        continue;
      }
      const complete = (
        sessionId: SessionId,
        replyId: (typeof Uuid)["Type"],
        modelQuestion: string,
        turn: (typeof SeedBtwTurn)["Type"],
      ) =>
        service.completeReply(spec.user_id, spec.vault_id, sessionId, replyId, {
          messages: [
            { role: "user", content: modelQuestion },
            { role: "assistant", content: turn.answer },
          ],
          sources: sourcesForThinking(turn.thinking),
          answer: turn.answer,
        });
      const rootReplyId = newUuid();
      const sessionId = yield* service.createSession(spec.user_id, spec.vault_id, {
        idempotencyKey: item.idempotency_key,
        ...(item.origin === undefined ? {} : { origin: item.origin }),
        pending: {
          replyId: rootReplyId,
          exchangeId: item.exchange.id,
          question: item.exchange.query,
        },
      });
      const rootAnchor = item.origin?.anchor;
      yield* complete(
        sessionId,
        rootReplyId,
        rootAnchor === undefined || rootAnchor === null
          ? item.exchange.query
          : composeAnchoredQuestion(
              { quote: rootAnchor, context: item.origin?.paragraph ?? null },
              item.exchange.query,
            ),
        item.exchange,
      );
      for (const exchange of item.follow_ups ?? []) {
        const replyId = newUuid();
        yield* service.appendPending(spec.user_id, spec.vault_id, sessionId, {
          replyId,
          exchangeId: exchange.id,
          question: exchange.query,
        });
        yield* complete(sessionId, replyId, exchange.query, exchange);
      }
      const latestBtws = new Map<string, (typeof SeedBtw)["Type"]>();
      for (const btw of item.btws ?? []) {
        latestBtws.set(`${btw.exchangeId}\0${btw.quote}`, btw);
      }
      for (const btw of latestBtws.values()) {
        for (const [index, turn] of btw.exchanges.entries()) {
          const replyId = newUuid();
          yield* service.appendPending(spec.user_id, spec.vault_id, sessionId, {
            replyId,
            exchangeId: newUuid(),
            question: turn.query,
            btw: {
              exchange_id: btw.exchangeId,
              quote: btw.quote,
              block_offset: btw.blockOffset,
              context: btw.context,
            },
          });
          yield* complete(
            sessionId,
            replyId,
            index === 0
              ? composeAnchoredQuestion({ quote: btw.quote, context: btw.context }, turn.query)
              : turn.query,
            turn,
          );
        }
      }
      out[item.key] = sessionId;
    }
    return out;
  }),
);
await runtime.dispose();
await writeFile(outputPath, `${JSON.stringify({ sessions: seeded }, null, 2)}\n`, "utf8");
