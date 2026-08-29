import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import * as SchemaIssue from "effect/SchemaIssue";

export type StorageBackend = "local" | "r2";

export type AppConfigShape = {
  readonly databaseUrl: Redacted.Redacted<string>;
  readonly jwtSecret: Redacted.Redacted<string>;
  readonly jwtAccessExpiryMinutes: number;
  readonly jwtRefreshExpiryDays: number;
  readonly authCodeExpiryMinutes: number;
  readonly webauthnRpId: string;
  readonly webauthnOrigins: readonly string[];
  readonly webauthnRpName: string;
  readonly resendApiKey: Option.Option<Redacted.Redacted<string>>;
  readonly resendFromEmail: Option.Option<string>;
  readonly dataDir: string;
  readonly storageBackend: StorageBackend;
  readonly r2AccountId: Option.Option<string>;
  readonly r2AccessKeyId: Option.Option<Redacted.Redacted<string>>;
  readonly r2SecretAccessKey: Option.Option<Redacted.Redacted<string>>;
  readonly r2BucketName: Option.Option<string>;
  readonly openRouterApiKey: Option.Option<Redacted.Redacted<string>>;
  readonly openRouterApiUrl: string;
  readonly parallelApiKey: Option.Option<Redacted.Redacted<string>>;
  readonly parallelSearchUrl: string;
  readonly queryModel: string;
  readonly queryFallbackModels: readonly string[];
  readonly extractModel: string;
  readonly mapModel: string;
  readonly reduceModel: string;
  readonly renderModel: string;
  readonly compileEnrichConcurrency: number;
  readonly compileWriteConcurrency: number;
  readonly compilePartitionTargetTokens: number;
  readonly compilePartitionMinFactor: number;
  readonly compilePartitionMaxFactor: number;
  readonly compilePremergeJaccardThreshold: number;
  readonly compileDeriveRelatedLimit: number;
  readonly pipelineConcurrency: number;
  readonly goldensRandomSeed: Option.Option<number>;
  readonly goldensClock: Option.Option<Date>;
  readonly embeddingModel: string;
  readonly corsOrigins: readonly string[];
  readonly suppressAuth: boolean;
  readonly allowPrivateUrlFetch: boolean;
  readonly serverHost: string;
  readonly serverPort: number;
};

export const DEFAULT_RENDER_MODEL = "qwen/qwen3.6-plus";

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()(
  "@great-minds/server/AppConfig",
) {}

const nonEmptyString = (name: string) => Config.schema(Schema.NonEmptyString, name);
const positiveInt = (name: string) =>
  Config.schema(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))), name);
const positiveNumber = (name: string) =>
  Config.schema(Schema.Number.pipe(Schema.check(Schema.isGreaterThan(0))), name);

const validateRedacted = (value: Redacted.Redacted<string>) =>
  Schema.decodeUnknownEffect(Schema.NonEmptyString)(Redacted.value(value)).pipe(
    Effect.as(value),
    Effect.mapError((error) => new Config.ConfigError(error)),
  );

const redactedNonEmpty = (name: string) =>
  Config.redacted(name).pipe(Config.mapOrFail(validateRedacted));

const appConfig = Config.all({
  databaseUrl: redactedNonEmpty("DATABASE_URL"),
  jwtSecret: redactedNonEmpty("JWT_SECRET"),
  jwtAccessExpiryMinutes: positiveInt("JWT_ACCESS_EXPIRY_MINUTES").pipe(Config.withDefault(30)),
  jwtRefreshExpiryDays: positiveInt("JWT_REFRESH_EXPIRY_DAYS").pipe(Config.withDefault(60)),
  authCodeExpiryMinutes: positiveInt("AUTH_CODE_EXPIRY_MINUTES").pipe(Config.withDefault(10)),
  webauthnRpId: nonEmptyString("WEBAUTHN_RP_ID").pipe(Config.withDefault("localhost")),
  webauthnOrigins: nonEmptyString("WEBAUTHN_ORIGINS").pipe(
    Config.withDefault("http://localhost:5173"),
    Config.map((raw) =>
      raw
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  ),
  webauthnRpName: nonEmptyString("WEBAUTHN_RP_NAME").pipe(Config.withDefault("Great Minds")),
  resendApiKey: Config.option(redactedNonEmpty("RESEND_API_KEY")),
  resendFromEmail: Config.option(nonEmptyString("RESEND_FROM_EMAIL")),
  dataDir: nonEmptyString("DATA_DIR").pipe(Config.withDefault("/data")),
  storageBackend: Config.literals(["local", "r2"] as const, "STORAGE_BACKEND").pipe(
    Config.withDefault("local" as const),
  ),
  r2AccountId: Config.option(nonEmptyString("R2_ACCOUNT_ID")),
  r2AccessKeyId: Config.option(redactedNonEmpty("R2_ACCESS_KEY_ID")),
  r2SecretAccessKey: Config.option(redactedNonEmpty("R2_SECRET_ACCESS_KEY")),
  r2BucketName: Config.option(nonEmptyString("R2_BUCKET_NAME")),
  openRouterApiKey: Config.option(redactedNonEmpty("OPENROUTER_API_KEY")),
  openRouterApiUrl: nonEmptyString("OPENROUTER_API_URL").pipe(
    Config.withDefault("https://openrouter.ai/api/v1"),
  ),
  parallelApiKey: Config.option(redactedNonEmpty("PARALLEL_API_KEY")),
  parallelSearchUrl: nonEmptyString("PARALLEL_SEARCH_URL").pipe(
    Config.withDefault("https://api.parallel.ai/v1beta/search"),
  ),
  queryModel: nonEmptyString("QUERY_MODEL").pipe(Config.withDefault("z-ai/glm-5.2")),
  queryFallbackModels: nonEmptyString("QUERY_FALLBACK_MODELS").pipe(
    Config.withDefault("deepseek/deepseek-v3.2"),
    Config.map((raw) =>
      raw
        .split(",")
        .map((model) => model.trim())
        .filter((model) => model.length > 0),
    ),
  ),
  extractModel: nonEmptyString("EXTRACT_MODEL").pipe(Config.withDefault("deepseek/deepseek-v3.2")),
  mapModel: nonEmptyString("MAP_MODEL").pipe(Config.withDefault("deepseek/deepseek-v3.2")),
  reduceModel: nonEmptyString("REDUCE_MODEL").pipe(
    Config.withDefault("anthropic/claude-sonnet-4.6"),
  ),
  renderModel: nonEmptyString("RENDER_MODEL").pipe(Config.withDefault(DEFAULT_RENDER_MODEL)),
  compileEnrichConcurrency: positiveInt("COMPILE_ENRICH_CONCURRENCY").pipe(Config.withDefault(20)),
  compileWriteConcurrency: positiveInt("COMPILE_WRITE_CONCURRENCY").pipe(Config.withDefault(3)),
  compilePartitionTargetTokens: positiveInt("COMPILE_PARTITION_TARGET_TOKENS").pipe(
    Config.withDefault(100_000),
  ),
  compilePartitionMinFactor: positiveNumber("COMPILE_PARTITION_MIN_FACTOR").pipe(
    Config.withDefault(0.3),
  ),
  compilePartitionMaxFactor: positiveNumber("COMPILE_PARTITION_MAX_FACTOR").pipe(
    Config.withDefault(1.5),
  ),
  compilePremergeJaccardThreshold: positiveNumber("COMPILE_PREMERGE_JACCARD_THRESHOLD").pipe(
    Config.withDefault(0.8),
  ),
  compileDeriveRelatedLimit: positiveInt("COMPILE_DERIVE_RELATED_LIMIT").pipe(
    Config.withDefault(20),
  ),
  pipelineConcurrency: positiveInt("PIPELINE_CONCURRENCY").pipe(Config.withDefault(1)),
  goldensRandomSeed: Config.option(Config.schema(Schema.Int, "GOLDENS_RANDOM_SEED")),
  goldensClock: Config.option(Config.schema(Schema.DateFromString, "GOLDENS_CLOCK")),
  embeddingModel: nonEmptyString("EMBEDDING_MODEL").pipe(
    Config.withDefault("qwen/qwen3-embedding-8b"),
  ),
  corsOrigins: nonEmptyString("CORS_ORIGINS").pipe(
    Config.withDefault("http://localhost:5173"),
    Config.map((raw) =>
      raw
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  ),
  suppressAuth: Config.boolean("SUPPRESS_AUTH").pipe(Config.withDefault(false)),
  allowPrivateUrlFetch: Config.boolean("ALLOW_PRIVATE_URL_FETCH").pipe(Config.withDefault(false)),
  serverHost: nonEmptyString("HOST").pipe(Config.withDefault("0.0.0.0")),
  serverPort: Config.port("PORT").pipe(Config.withDefault(8787)),
}).pipe(
  Config.mapOrFail((config) => {
    if (config.webauthnOrigins.length === 0) {
      return Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message: "WEBAUTHN_ORIGINS must contain at least one origin",
            }),
          ),
        ),
      );
    }
    if (config.storageBackend === "local") {
      return Effect.succeed(config);
    }
    if (
      Option.isSome(config.r2AccountId) &&
      Option.isSome(config.r2AccessKeyId) &&
      Option.isSome(config.r2SecretAccessKey) &&
      Option.isSome(config.r2BucketName)
    ) {
      return Effect.succeed(config);
    }
    return Effect.fail(
      new Config.ConfigError(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue({
            message:
              "STORAGE_BACKEND=r2 requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME",
          }),
        ),
      ),
    );
  }),
);

export const AppConfigLive = Layer.effect(AppConfig, appConfig);
