import { writeFile } from "node:fs/promises";

import { Database, sessions } from "@great-minds/database";
import { BtwData, ExchangeData, SessionOrigin, Uuid } from "@great-minds/domain";
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

const SessionSpec = Schema.Struct({
  key: Schema.String,
  idempotency_key: Schema.String,
  exchange: ExchangeData,
  origin: Schema.optionalKey(SessionOrigin),
  btws: Schema.optionalKey(Schema.Array(BtwData)),
  follow_ups: Schema.optionalKey(Schema.Array(ExchangeData)),
});

const SeedSpec = Schema.Struct({
  user_id: Uuid,
  vault_id: Uuid,
  sessions: Schema.Array(SessionSpec),
});
const decodeSeedSpec = Schema.decodeUnknownSync(SeedSpec);

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
      const sessionId = yield* service.createSession(spec.user_id, spec.vault_id, {
        idempotencyKey: item.idempotency_key,
        exchange: item.exchange,
        ...(item.origin === undefined ? {} : { origin: item.origin }),
      });
      for (const btw of item.btws ?? []) {
        yield* service.appendBtw(spec.user_id, spec.vault_id, sessionId, btw);
      }
      for (const exchange of item.follow_ups ?? []) {
        yield* service.appendExchange(spec.user_id, spec.vault_id, sessionId, exchange);
      }
      out[item.key] = sessionId;
    }
    return out;
  }),
);
await runtime.dispose();
await writeFile(outputPath, `${JSON.stringify({ sessions: seeded }, null, 2)}\n`, "utf8");
