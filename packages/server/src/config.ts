import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import * as SchemaIssue from "effect/SchemaIssue";

export type StorageBackend = "local" | "r2";

export type AppConfigShape = {
  readonly databaseUrl: Redacted.Redacted<string>;
  readonly jwtSecret: Redacted.Redacted<string>;
  readonly jwtAccessExpiryMinutes: number;
  readonly jwtRefreshExpiryDays: number;
  readonly authCodeExpiryMinutes: number;
  readonly resendApiKey: Redacted.Redacted<string>;
  readonly resendFromEmail: string;
  readonly dataDir: string;
  readonly storageBackend: StorageBackend;
  readonly r2AccountId: Option.Option<string>;
  readonly r2AccessKeyId: Option.Option<Redacted.Redacted<string>>;
  readonly r2SecretAccessKey: Option.Option<Redacted.Redacted<string>>;
  readonly r2BucketPrefix: string;
  readonly suppressAuth: boolean;
  readonly serverHost: string;
  readonly serverPort: number;
};

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()(
  "@great-minds/server/AppConfig",
) {}

const nonEmptyString = (name: string) => Config.schema(Schema.NonEmptyString, name);
const positiveInt = (name: string) =>
  Config.schema(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))), name);

const validateRedacted = (value: Redacted.Redacted<string>) =>
  Schema.decodeUnknownEffect(Schema.NonEmptyString)(Redacted.value(value)).pipe(
    Effect.as(value),
    Effect.mapError((error) => new Config.ConfigError(error)),
  );

export const redactedNonEmpty = (name: string) =>
  Config.redacted(name).pipe(Config.mapOrFail(validateRedacted));

export const appConfig = Config.all({
  databaseUrl: redactedNonEmpty("DATABASE_URL"),
  jwtSecret: redactedNonEmpty("JWT_SECRET"),
  jwtAccessExpiryMinutes: positiveInt("JWT_ACCESS_EXPIRY_MINUTES").pipe(Config.withDefault(30)),
  jwtRefreshExpiryDays: positiveInt("JWT_REFRESH_EXPIRY_DAYS").pipe(Config.withDefault(7)),
  authCodeExpiryMinutes: positiveInt("AUTH_CODE_EXPIRY_MINUTES").pipe(Config.withDefault(10)),
  resendApiKey: redactedNonEmpty("RESEND_API_KEY"),
  resendFromEmail: nonEmptyString("RESEND_FROM_EMAIL"),
  dataDir: nonEmptyString("DATA_DIR").pipe(Config.withDefault("/data")),
  storageBackend: Config.literals(["local", "r2"] as const, "STORAGE_BACKEND").pipe(
    Config.withDefault("local" as const),
  ),
  r2AccountId: Config.option(nonEmptyString("R2_ACCOUNT_ID")),
  r2AccessKeyId: Config.option(redactedNonEmpty("R2_ACCESS_KEY_ID")),
  r2SecretAccessKey: Config.option(redactedNonEmpty("R2_SECRET_ACCESS_KEY")),
  r2BucketPrefix: nonEmptyString("R2_BUCKET_PREFIX").pipe(Config.withDefault("gm")),
  suppressAuth: Config.boolean("SUPPRESS_AUTH").pipe(Config.withDefault(false)),
  serverHost: nonEmptyString("HOST").pipe(Config.withDefault("0.0.0.0")),
  serverPort: Config.port("PORT").pipe(Config.withDefault(8787)),
}).pipe(
  Config.mapOrFail((config) => {
    if (config.storageBackend === "local") {
      return Effect.succeed(config);
    }
    if (
      Option.isSome(config.r2AccountId) &&
      Option.isSome(config.r2AccessKeyId) &&
      Option.isSome(config.r2SecretAccessKey)
    ) {
      return Effect.succeed(config);
    }
    return Effect.fail(
      new Config.ConfigError(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue(Option.some(config.storageBackend), {
            message:
              "STORAGE_BACKEND=r2 requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY",
          }),
        ),
      ),
    );
  }),
);

export const AppConfigLive = Layer.effect(AppConfig, appConfig);
