import { NodeRuntime } from "@effect/platform-node";
import * as PgClient from "@effect/sql-pg/PgClient";
import { DatabaseLive, logMigrationResult, migrateDatabase } from "@great-minds/database";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { makeAppLayers } from "./app-layer.ts";
import { makeTestClock } from "./clock.ts";
import { AppConfig, AppConfigLive } from "./config.ts";
import { makeTestRandomBytes } from "./random.ts";
import { openServer } from "./server.ts";
import { ensureStorageReady } from "./storage.ts";

const logEvent = (body: Record<string, unknown>) =>
  Effect.sync(() => console.log(JSON.stringify(body)));

const serveUntilInterrupted = Effect.gen(function* () {
  const config = yield* AppConfig.pipe(Effect.provide(AppConfigLive));
  const MigrationLive = DatabaseLive.pipe(
    Layer.provide(PgClient.layer({ url: config.databaseUrl })),
  );
  const migrationResult = yield* migrateDatabase.pipe(Effect.provide(MigrationLive));
  yield* Effect.sync(() => logMigrationResult(migrationResult));

  yield* ensureStorageReady(config);
  yield* logEvent({ event: "storage_ready", backend: config.storageBackend });

  if (Option.isSome(config.goldensClock) || Option.isSome(config.goldensRandomSeed)) {
    yield* Effect.sync(() =>
      console.error(
        JSON.stringify({
          event: "determinism_pins_active",
          level: "warn",
          detail:
            "GOLDENS_CLOCK/GOLDENS_RANDOM_SEED pin the clock and identity stream; never set these in production",
        }),
      ),
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
  const url = yield* openServer({ layer: Layer.mergeAll(layers.app, layers.reconcilerLoop) });
  yield* logEvent({ event: "server_listening", url });
  yield* Effect.never;
}).pipe(Effect.scoped);

NodeRuntime.runMain(serveUntilInterrupted, {
  disableErrorReporting: true,
  teardown: (exit, onExit) => {
    if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
      onExit(0);
      return;
    }
    console.error(
      JSON.stringify({
        event: "server_failed",
        level: "error",
        error_message: Cause.pretty(exit.cause),
      }),
    );
    onExit(1);
  },
});
