import * as PgClient from "@effect/sql-pg/PgClient";
import { DatabaseLive, logMigrationResult, migrateDatabase } from "@great-minds/database";
import { Effect, Layer, Option } from "effect";

import { makeAppLayers } from "./app-layer.ts";
import { makeTestClock } from "./clock.ts";
import { AppConfig, AppConfigLive } from "./config.ts";
import { makeTestRandomBytes } from "./random.ts";
import { startServer } from "./server.ts";
import { ensureSharedBucket } from "./storage.ts";

const config = await Effect.runPromise(AppConfig.pipe(Effect.provide(AppConfigLive)));
const MigrationLive = DatabaseLive.pipe(Layer.provide(PgClient.layer({ url: config.databaseUrl })));
const migrationResult = await Effect.runPromise(
  migrateDatabase.pipe(Effect.provide(MigrationLive)),
);
logMigrationResult(migrationResult);

await Effect.runPromise(ensureSharedBucket(config));
console.log(JSON.stringify({ event: "storage_ready", backend: config.storageBackend }));

if (Option.isSome(config.goldensClock) || Option.isSome(config.goldensRandomSeed)) {
  console.error(
    JSON.stringify({
      event: "determinism_pins_active",
      level: "warn",
      detail:
        "GOLDENS_CLOCK/GOLDENS_RANDOM_SEED pin the clock and identity stream; never set these in production",
    }),
  );
}

const layers = makeAppLayers({
  config: Layer.succeed(AppConfig, config),
  ...(Option.isSome(config.goldensClock)
    ? { clock: makeTestClock(config.goldensClock.value).layer }
    : {}),
  ...(Option.isSome(config.goldensRandomSeed)
    ? { randomBytes: makeTestRandomBytes(config.goldensRandomSeed.value).layer }
    : {}),
});
const MainLive = Layer.mergeAll(layers.app, layers.reconcilerLoop);

const started = await startServer({
  layer: MainLive,
});
console.log(JSON.stringify({ event: "server_listening", url: started.url }));
