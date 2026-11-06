import { readFileSync } from "node:fs";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as PgClient from "@effect/sql-pg/PgClient";
import { DatabaseLive, logMigrationResult, migrateDatabase } from "@great-minds/database";
import { Email, Uuid } from "@great-minds/domain";
import { Cause, Console, Data, Effect, Exit, Layer, Option } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";

import { makeAppLayers } from "./app-layer.ts";
import { AuthService, AuthServiceLive } from "./auth.ts";
import { ClockLive } from "./clock.ts";
import { AppConfig, AppConfigLive, type AppConfigShape } from "./config.ts";
import { PgClientLive } from "./db.ts";
import { errorDetails } from "./error-details.ts";
import { StructuredLoggerLive } from "./logging.ts";
import { MailerLive } from "./mailer.ts";
import { openServer } from "./server.ts";
import {
  ContentStorageLive,
  StagedStorageLive,
  StorageBackendLive,
  ensureStorageReady,
} from "./storage.ts";
import { TokenServiceLive } from "./tokens.ts";
import { VaultAccessServiceLive, VaultsServiceLive } from "./vaults.ts";

class UserNotFound extends Data.TaggedError("UserNotFound")<{ readonly email: string }> {
  override get message() {
    return `no active user with email ${this.email}`;
  }
}

const logEvent = (body: Record<string, unknown>) =>
  Effect.sync(() => console.log(JSON.stringify(body)));

const migrate = (config: AppConfigShape) =>
  migrateDatabase.pipe(
    Effect.provide(DatabaseLive.pipe(Layer.provide(PgClient.layer({ url: config.databaseUrl })))),
    Effect.tap((result) => Effect.sync(() => logMigrationResult(result))),
  );

const serve = Effect.gen(function* () {
  const config = yield* AppConfig;
  yield* migrate(config);
  yield* ensureStorageReady(config);
  yield* logEvent({ event: "storage_ready", backend: config.storageBackend });
  const layers = makeAppLayers({ config: Layer.succeed(AppConfig, config) });
  const url = yield* openServer({ layer: Layer.mergeAll(layers.app, layers.reconcilerLoop) });
  yield* logEvent({ event: "server_listening", url });
  yield* Effect.never;
}).pipe(
  Effect.scoped,
  Effect.provide(AppConfigLive),
  Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause)
      : logEvent({
          event: "server_failed",
          level: "error",
          error_message: Cause.pretty(cause),
        }).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1)))),
  ),
);

const AdminBase = Layer.mergeAll(
  DatabaseLive.pipe(Layer.provide(PgClientLive)),
  ClockLive,
  StructuredLoggerLive,
).pipe(Layer.provideMerge(AppConfigLive));

const AdminLive = AuthServiceLive.pipe(
  Layer.provide(VaultsServiceLive),
  Layer.provide(VaultAccessServiceLive),
  Layer.provide(
    Layer.mergeAll(
      MailerLive,
      TokenServiceLive,
      Layer.mergeAll(ContentStorageLive, StagedStorageLive).pipe(Layer.provide(StorageBackendLive)),
    ).pipe(Layer.provideMerge(AdminBase)),
  ),
);

const existingUser = (email: Email) =>
  Effect.flatMap(AuthService, (auth) =>
    Effect.flatMap(auth.findUser(email), (found) =>
      Option.isSome(found) ? Effect.succeed(found.value) : Effect.fail(new UserNotFound({ email })),
    ),
  );

const emailFlag = Flag.string("email").pipe(
  Flag.withSchema(Email),
  Flag.withDescription("The user's email address"),
);

const serveCommand = Command.make("serve", {}, () => serve).pipe(
  Command.withDescription("Run migrations, then serve the API and background work"),
);

const migrateCommand = Command.make("migrate", {}, () =>
  Effect.flatMap(AppConfig, migrate).pipe(Effect.provide(AppConfigLive)),
).pipe(Command.withDescription("Apply database migrations and exit"));

const usersCreateCommand = Command.make("create", { email: emailFlag }, ({ email }) =>
  Effect.gen(function* () {
    const auth = yield* AuthService;
    const userId = yield* auth.ensureUser(email);
    yield* Console.log(`${email} ${userId}`);
  }).pipe(Effect.provide(AdminLive)),
).pipe(Command.withDescription("Create a user (if new) with their default vault"));

const keysCreateCommand = Command.make(
  "create",
  {
    email: emailFlag,
    label: Flag.string("label").pipe(
      Flag.withDescription("Name shown in Settings"),
      Flag.withDefault("created on the server"),
    ),
  },
  ({ email, label }) =>
    Effect.gen(function* () {
      const auth = yield* AuthService;
      const key = yield* auth.createApiKey(yield* auth.ensureUser(email), label);
      yield* Console.log(key.raw_key);
      yield* Console.error(`API key "${key.label}" for ${email} (${key.id}). Shown only once.`);
    }).pipe(Effect.provide(AdminLive)),
).pipe(
  Command.withDescription("Create an API key for a user, creating the user if new; prints the key"),
);

const keysListCommand = Command.make("list", { email: emailFlag }, ({ email }) =>
  Effect.gen(function* () {
    const auth = yield* AuthService;
    const keys = yield* auth.listApiKeys(yield* existingUser(email));
    for (const key of keys)
      yield* Console.log(
        `${key.id}  ${key.revoked ? "revoked" : "active "}  ${key.created_at.toISOString().slice(0, 10)}  ${key.label}`,
      );
  }).pipe(Effect.provide(AdminLive)),
).pipe(Command.withDescription("List a user's API keys"));

const keysRevokeCommand = Command.make(
  "revoke",
  {
    email: emailFlag,
    key: Argument.string("id").pipe(Argument.withSchema(Uuid), Argument.withDescription("Key id")),
  },
  ({ email, key }) =>
    Effect.gen(function* () {
      const auth = yield* AuthService;
      yield* auth.revokeApiKey(yield* existingUser(email), key);
      yield* Console.log(`Revoked ${key}.`);
    }).pipe(Effect.provide(AdminLive)),
).pipe(Command.withDescription("Revoke one of a user's API keys"));

const greatMinds = Command.make("great-minds").pipe(
  Command.withDescription("Run and administer a Great Minds server"),
  Command.withSubcommands([
    serveCommand,
    migrateCommand,
    Command.make("users").pipe(
      Command.withDescription("Manage users"),
      Command.withSubcommands([usersCreateCommand]),
    ),
    Command.make("keys").pipe(
      Command.withDescription("Manage API keys"),
      Command.withSubcommands([keysCreateCommand, keysListCommand, keysRevokeCommand]),
    ),
  ]),
);

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const program = Command.runWith(greatMinds, { version: String(version) })(
  process.argv.slice(2),
).pipe(
  Effect.catchCause((cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
    const failure = Cause.squash(cause);
    return Effect.sync(() => {
      if (CliError.isCliError(failure)) {
        if (failure._tag !== "ShowHelp" || failure.errors.length > 0) process.exitCode = 1;
        return;
      }
      process.stderr.write(`great-minds: ${errorDetails(failure).message}\n`);
      process.exitCode = 1;
    });
  }),
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program, {
  disableErrorReporting: true,
  teardown: (exit, onExit) =>
    onExit(Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? 0 : 1),
});
