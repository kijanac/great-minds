import { parseArgs } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { DatabaseLive } from "@great-minds/database";
import { Email } from "@great-minds/domain";
import { Console, Effect, Layer, Schema } from "effect";

import { AuthService, AuthServiceLive } from "./auth.ts";
import { ClockLive } from "./clock.ts";
import { AppConfigLive } from "./config.ts";
import { PgClientLive } from "./db.ts";
import { StructuredLoggerLive } from "./logging.ts";
import { MailerLive } from "./mailer.ts";
import { ContentStorageLive, StagedStorageLive, StorageBackendLive } from "./storage.ts";
import { TokenServiceLive } from "./tokens.ts";
import { VaultAccessServiceLive, VaultsServiceLive } from "./vaults.ts";

const { values } = parseArgs({
  options: { email: { type: "string" }, label: { type: "string" } },
});

const program = Effect.gen(function* () {
  const email = yield* Schema.decodeUnknownEffect(Email)(values.email);
  const auth = yield* AuthService;
  const key = yield* auth.createUserKey(email, values.label ?? "created on the server");
  yield* Console.log(key.raw_key);
  yield* Console.error(
    `API key "${key.label}" for ${email} (id ${key.id}). It is shown only once.`,
  );
});

const Base = Layer.mergeAll(
  DatabaseLive.pipe(Layer.provide(PgClientLive)),
  ClockLive,
  StructuredLoggerLive,
).pipe(Layer.provideMerge(AppConfigLive));

const Adapters = Layer.mergeAll(
  MailerLive,
  TokenServiceLive,
  Layer.mergeAll(ContentStorageLive, StagedStorageLive).pipe(Layer.provide(StorageBackendLive)),
).pipe(Layer.provideMerge(Base));

const Live = AuthServiceLive.pipe(
  Layer.provide(VaultsServiceLive),
  Layer.provide(VaultAccessServiceLive),
  Layer.provide(Adapters),
);

NodeRuntime.runMain(program.pipe(Effect.provide(Live)));
