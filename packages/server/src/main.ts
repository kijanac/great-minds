import { readFileSync } from "node:fs";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Database,
  DatabaseLive,
  layerPgClient,
  logMigrationResult,
  migrateDatabase,
  vaultMemberships,
  vaults,
} from "@great-minds/database";
import { type ApiKey, Email, Uuid } from "@great-minds/domain";
import { and, eq, isNull } from "drizzle-orm";
import { Cause, Config, Console, Data, Effect, Exit, Layer, Option, type Redacted } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";

import { makeAppLayers } from "./app-layer.ts";
import { AuthService, AuthServiceLive } from "./auth.ts";
import { ClockLive, ClockService } from "./clock.ts";
import { AppConfig, AppConfigLive } from "./config.ts";
import { PgClientLive } from "./db.ts";
import { errorDetails } from "./error-details.ts";
import { StructuredLoggerLive } from "./logging.ts";
import { MailerLive } from "./mailer.ts";
import { openServer } from "./server.ts";
import { ensureStorageReady } from "./storage.ts";
import { TokenServiceLive } from "./tokens.ts";

class UserNotFound extends Data.TaggedError("UserNotFound")<{ readonly email: string }> {
  override get message() {
    return `no active user with email ${this.email}`;
  }
}

class KeyScopeInvalid extends Data.TaggedError("KeyScopeInvalid")<{ readonly detail: string }> {
  override get message() {
    return this.detail;
  }
}

const logEvent = (body: Record<string, unknown>) =>
  Effect.sync(() => console.log(JSON.stringify(body)));

const migrate = (databaseUrl: Redacted.Redacted<string>) =>
  migrateDatabase.pipe(
    Effect.provide(DatabaseLive.pipe(Layer.provide(layerPgClient({ url: databaseUrl })))),
    Effect.tap((result) => Effect.sync(() => logMigrationResult(result))),
  );

const serve = Effect.gen(function* () {
  const config = yield* AppConfig;
  yield* migrate(config.databaseUrl);
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
  Layer.provideMerge(
    Layer.mergeAll(MailerLive, TokenServiceLive).pipe(Layer.provideMerge(AdminBase)),
  ),
);

const existingUser = (email: Email) =>
  Effect.flatMap(AuthService, (auth) =>
    Effect.flatMap(auth.findUser(email), (found) =>
      Option.isSome(found) ? Effect.succeed(found.value) : Effect.fail(new UserNotFound({ email })),
    ),
  );

const emailFlag = Flag.String("email").pipe(
  Flag.withSchema(Email),
  Flag.withDescription("The user's email address"),
);

const serveCommand = Command.make("serve", {}, () => serve).pipe(
  Command.withDescription("Run migrations, then serve the API and background work"),
);

const migrateCommand = Command.make("migrate", {}, () =>
  Effect.flatMap(Config.Redacted("DATABASE_URL"), migrate),
).pipe(Command.withDescription("Apply database migrations and exit (needs only DATABASE_URL)"));

const sponsoredFlag = Flag.Boolean("sponsored").pipe(
  Flag.withDescription("Let the account use this server's models"),
  Flag.withDefault(false),
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text"),
  Flag.withDefault(false),
);

const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

const day = (date: Date) => date.toISOString().slice(0, 10);

const normalized = (value: string) => value.trim().toLowerCase();

const userVaults = (userId: Uuid) =>
  Effect.flatMap(Database, (db) =>
    db.query((d) =>
      d
        .select({ id: vaults.id, name: vaults.name })
        .from(vaultMemberships)
        .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
        .where(and(eq(vaultMemberships.userId, userId), isNull(vaults.deletedAt))),
    ),
  );

const chooseVault = (
  reachable: ReadonlyArray<{ readonly id: Uuid; readonly name: string }>,
  wanted: string,
) => {
  const matches = reachable.filter(
    (vault) => vault.id === normalized(wanted) || normalized(vault.name) === normalized(wanted),
  );
  const [match, ...others] = matches;
  if (match !== undefined && others.length === 0) return Effect.succeed(match.id);
  return Effect.fail(
    new KeyScopeInvalid({
      detail:
        match === undefined
          ? `the user has no vault named "${wanted}"`
          : `${matches.length} vaults are named "${wanted}"; use its id`,
    }),
  );
};

const scopeText = (key: ApiKey, names: ReadonlyMap<string, string>, now: Date) => {
  const reach =
    key.vault_ids === null
      ? "all vaults"
      : key.vault_ids.map((id) => names.get(id) ?? id).join(", ");
  const can =
    key.can_ask && key.can_change
      ? "ask, change"
      : key.can_ask
        ? "ask"
        : key.can_change
          ? "change"
          : "read only";
  const expiry =
    key.expires_at === null
      ? "never expires"
      : `${key.expires_at <= now ? "expired" : "expires"} ${day(key.expires_at)}`;
  const used = key.last_used_at === null ? "never used" : `used ${day(key.last_used_at)}`;
  return [reach, can, expiry, used].join(" · ");
};

const usersCreateCommand = Command.make(
  "create",
  { email: emailFlag, sponsored: sponsoredFlag },
  ({ email, sponsored }) =>
    Effect.gen(function* () {
      const auth = yield* AuthService;
      const userId = yield* auth.ensureUser(email);
      if (sponsored) yield* auth.setSponsored(userId, true);
      yield* Console.log(`${email} ${userId}`);
    }).pipe(Effect.provide(AdminLive)),
).pipe(Command.withDescription("Create a user (if new) with their default vault"));

const sponsorCommand = (sponsored: boolean) =>
  Command.make(sponsored ? "sponsor" : "unsponsor", { email: emailFlag }, ({ email }) =>
    Effect.gen(function* () {
      const auth = yield* AuthService;
      yield* auth.setSponsored(yield* existingUser(email), sponsored);
      yield* Console.log(
        sponsored
          ? `${email} can now use this server's models.`
          : `${email} can no longer use this server's models.`,
      );
    }).pipe(Effect.provide(AdminLive)),
  ).pipe(
    Command.withDescription(
      sponsored
        ? "Let a user's actions use this server's models (asking, search, Updates, adding documents)"
        : "Stop a user's actions from using this server's models",
    ),
  );

const usersListCommand = Command.make("list", { json: jsonFlag }, ({ json }) =>
  Effect.gen(function* () {
    const auth = yield* AuthService;
    const users = yield* auth.listUsers();
    if (json)
      return yield* printJson(
        users.map((user) => ({
          email: user.email,
          sponsored: user.sponsored,
          created_at: user.createdAt,
        })),
      );
    for (const user of users)
      yield* Console.log(
        `${user.sponsored ? "sponsored  " : "-          "}${day(user.createdAt)}  ${user.email}`,
      );
  }).pipe(Effect.provide(AdminLive)),
).pipe(Command.withDescription("List users and whether each is sponsored"));

const usersCodeCommand = Command.make("code", { email: emailFlag }, ({ email }) =>
  Effect.gen(function* () {
    const auth = yield* AuthService;
    yield* existingUser(email);
    const code = yield* auth.issueSignInCode(email);
    yield* Console.log(code);
    yield* Console.error(`One-time sign-in code for ${email}. It works once and expires soon.`);
  }).pipe(Effect.provide(AdminLive)),
).pipe(
  Command.withDescription(
    "Print a one-time sign-in code for an existing user, without sending email",
  ),
);

const keysCreateCommand = Command.make(
  "create",
  {
    email: emailFlag,
    label: Flag.String("label").pipe(
      Flag.withDescription("Name shown in Settings"),
      Flag.withDefault("created on the server"),
    ),
    sponsored: sponsoredFlag,
    vault: Flag.String("vault").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Limit the key to this vault, by name or id; repeat for more (default: all the user's vaults)",
      ),
    ),
    ask: Flag.Boolean("ask").pipe(
      Flag.withDescription("Let the key ask questions, which uses models (--no-ask forbids it)"),
      Flag.withDefault(true),
    ),
    change: Flag.Boolean("change").pipe(
      Flag.withDescription("Let the key add documents and make changes (--no-change forbids it)"),
      Flag.withDefault(true),
    ),
    expires: Flag.Date("expires").pipe(
      Flag.withDescription(
        "Stop accepting the key from this date or time, e.g. 2027-01-31 (default: never)",
      ),
      Flag.optional,
    ),
    json: jsonFlag,
  },
  ({ email, label, sponsored, vault, ask, change, expires, json }) =>
    Effect.gen(function* () {
      const auth = yield* AuthService;
      const now = yield* (yield* ClockService).now;
      const expiresAt = Option.getOrNull(expires);
      if (expiresAt !== null && expiresAt <= now)
        return yield* new KeyScopeInvalid({ detail: "--expires must be in the future" });
      const userId = yield* auth.ensureUser(email);
      const reachable = yield* userVaults(userId);
      const vaultIds =
        vault.length === 0
          ? null
          : [...new Set(yield* Effect.forEach(vault, (wanted) => chooseVault(reachable, wanted)))];
      if (sponsored) yield* auth.setSponsored(userId, true);
      const key = yield* auth.createApiKey(userId, label, {
        vaultIds,
        canAsk: ask,
        canChange: change,
        expiresAt,
      });
      yield* json ? printJson(key) : Console.log(key.raw_key);
      const names = new Map(reachable.map((vault) => [vault.id, vault.name]));
      yield* Console.error(
        `API key "${key.label}" for ${email} (${key.id}): ${scopeText(key, names, now)}. Shown only once.`,
      );
    }).pipe(Effect.provide(AdminLive)),
).pipe(
  Command.withDescription(
    "Create an API key for a user, creating the user if new; prints the key (or the key record with --json)",
  ),
);

const keysListCommand = Command.make(
  "list",
  { email: emailFlag, json: jsonFlag },
  ({ email, json }) =>
    Effect.gen(function* () {
      const auth = yield* AuthService;
      const userId = yield* existingUser(email);
      const keys = yield* auth.listApiKeys(userId);
      if (json) return yield* printJson(keys);
      const now = yield* (yield* ClockService).now;
      const names = new Map((yield* userVaults(userId)).map((vault) => [vault.id, vault.name]));
      for (const key of keys) {
        yield* Console.log(
          `${key.id}  ${key.revoked ? "revoked" : "active "}  ${day(key.created_at)}  ${key.label}`,
        );
        yield* Console.log(`    ${scopeText(key, names, now)}`);
      }
    }).pipe(Effect.provide(AdminLive)),
).pipe(
  Command.withDescription(
    "List a user's API keys: vaults, permissions, expiry and last use (--json for scripts)",
  ),
);

const keysRevokeCommand = Command.make(
  "revoke",
  {
    email: emailFlag,
    key: Argument.String("id").pipe(Argument.withSchema(Uuid), Argument.withDescription("Key id")),
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
      Command.withSubcommands([
        usersCreateCommand,
        usersCodeCommand,
        usersListCommand,
        sponsorCommand(true),
        sponsorCommand(false),
      ]),
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
