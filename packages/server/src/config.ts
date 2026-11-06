import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import * as SchemaIssue from "effect/SchemaIssue";

export type StorageBackend = "local" | "r2";

export type ProviderKind = "openrouter" | "openai";

export type Provider = {
  readonly name: string;
  readonly kind: ProviderKind;
  readonly url: string;
  readonly apiKey: Option.Option<Redacted.Redacted<string>>;
};

export type ModelPrice = { readonly inputPerMillion: number; readonly outputPerMillion: number };

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
  readonly providers: ReadonlyMap<string, Provider>;
  readonly modelPrices: ReadonlyMap<string, ModelPrice>;
  readonly parallelApiKey: Option.Option<Redacted.Redacted<string>>;
  readonly parallelSearchUrl: string;
  readonly queryModel: string;
  readonly queryFallbackModels: readonly string[];
  readonly extractModel: string;
  readonly mapModel: string;
  readonly reduceModel: string;
  readonly renderModel: string;
  readonly queryTemperature: Option.Option<number>;
  readonly extractTemperature: Option.Option<number>;
  readonly mapTemperature: Option.Option<number>;
  readonly reduceTemperature: Option.Option<number>;
  readonly renderTemperature: Option.Option<number>;
  readonly renderReasoningEffort: Option.Option<ReasoningEffort>;
  readonly queryReasoningEffort: Option.Option<ReasoningEffort>;
  readonly extractReasoningEffort: Option.Option<ReasoningEffort>;
  readonly mapReasoningEffort: Option.Option<ReasoningEffort>;
  readonly reduceReasoningEffort: Option.Option<ReasoningEffort>;
  readonly compileEnrichConcurrency: number;
  readonly compileWriteConcurrency: number;
  readonly compileEmbedConcurrency: number;
  readonly compileDeriveRelatedLimit: number;
  readonly pipelineConcurrency: number;
  readonly embeddingModel: string;
  readonly embeddingProviders: readonly string[];
  readonly corsOrigins: readonly string[];
  readonly publicWebUrl: URL;
  readonly typstBinary: string;
  readonly clientIpHeader: Option.Option<string>;
  readonly allowPrivateUrlFetch: boolean;
  readonly serverHost: string;
  readonly serverPort: number;
};

export const DEFAULT_RENDER_MODEL = "z-ai/glm-5.3";

export type ReasoningEffort = "none" | "low" | "high" | "max";

export const optionalRedactedValue = (value: Option.Option<Redacted.Redacted<string>>) =>
  Option.match(value, {
    onNone: () => undefined,
    onSome: Redacted.value,
  });

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()(
  "@great-minds/server/AppConfig",
) {}

const nonEmptyString = (name: string) => Config.schema(Schema.NonEmptyString, name);
const positiveInt = (name: string) =>
  Config.schema(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))), name);
const commaList = (name: string, fallback: string) =>
  nonEmptyString(name).pipe(
    Config.withDefault(fallback),
    Config.map((raw) =>
      raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
const samplingTemperature = (name: string, fallback: Option.Option<number>) =>
  Config.option(
    Config.schema(
      Schema.Union([
        Schema.Literal("none"),
        Schema.Number.pipe(
          Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(2)),
        ),
      ]),
      name,
    ),
  ).pipe(
    Config.map(
      Option.match({
        onNone: () => fallback,
        onSome: (value) => (value === "none" ? Option.none() : Option.some(value)),
      }),
    ),
  );

const reasoningEffort = (name: string) =>
  Config.option(Config.literals(["none", "low", "high", "max"] as const, name));

const validateRedacted = (value: Redacted.Redacted<string>) =>
  Schema.decodeUnknownEffect(Schema.NonEmptyString)(Redacted.value(value)).pipe(
    Effect.as(value),
    Effect.mapError((error) => new Config.ConfigError(error)),
  );

const redactedNonEmpty = (name: string) =>
  Config.redacted(name).pipe(Config.mapOrFail(validateRedacted));

const providerName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/)));

const namedProvider = (name: string) =>
  Config.all({
    url: nonEmptyString(`PROVIDER_${name.toUpperCase()}_URL`),
    apiKey: Config.option(redactedNonEmpty(`PROVIDER_${name.toUpperCase()}_KEY`)),
    kind: Config.literals(
      ["openai", "openrouter"] as const,
      `PROVIDER_${name.toUpperCase()}_KIND`,
    ).pipe(Config.withDefault<ProviderKind>("openai")),
  }).pipe(Config.map((settings): Provider => ({ name, ...settings })));

const configError = (message: string) =>
  new Config.ConfigError(new Schema.SchemaError(new SchemaIssue.InvalidValue({ message })));

const providerNames = commaList("PROVIDERS", "").pipe(
  Config.mapOrFail((names) =>
    Effect.forEach(names, (name) =>
      Schema.decodeUnknownEffect(providerName)(name).pipe(
        Effect.mapError((error) => new Config.ConfigError(error)),
      ),
    ),
  ),
);

const PRICE_ENTRY = /^(.+)=(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/;

const modelPrices = commaList("MODEL_PRICES", "").pipe(
  Config.mapOrFail((entries) =>
    Effect.forEach(entries, (entry) => {
      const match = PRICE_ENTRY.exec(entry);
      return match === null
        ? Effect.fail(
            configError(
              `MODEL_PRICES entry "${entry}" must look like provider:model=input/output (USD per million tokens)`,
            ),
          )
        : Effect.succeed([
            match[1]!.trim(),
            { inputPerMillion: Number(match[2]), outputPerMillion: Number(match[3]) },
          ] as const);
    }),
  ),
  Config.map((entries) => new Map(entries)),
);

const appConfig = Config.all({
  databaseUrl: redactedNonEmpty("DATABASE_URL"),
  jwtSecret: redactedNonEmpty("JWT_SECRET"),
  jwtAccessExpiryMinutes: positiveInt("JWT_ACCESS_EXPIRY_MINUTES").pipe(Config.withDefault(30)),
  jwtRefreshExpiryDays: positiveInt("JWT_REFRESH_EXPIRY_DAYS").pipe(Config.withDefault(60)),
  authCodeExpiryMinutes: positiveInt("AUTH_CODE_EXPIRY_MINUTES").pipe(Config.withDefault(10)),
  webauthnRpId: nonEmptyString("WEBAUTHN_RP_ID").pipe(Config.withDefault("localhost")),
  webauthnOrigins: commaList("WEBAUTHN_ORIGINS", "http://localhost:5173"),
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
  modelPrices,
  parallelApiKey: Config.option(redactedNonEmpty("PARALLEL_API_KEY")),
  parallelSearchUrl: nonEmptyString("PARALLEL_SEARCH_URL").pipe(
    Config.withDefault("https://api.parallel.ai/v1beta/search"),
  ),
  queryModel: nonEmptyString("QUERY_MODEL").pipe(Config.withDefault("z-ai/glm-5.2")),
  queryFallbackModels: commaList("QUERY_FALLBACK_MODELS", "deepseek/deepseek-v3.2"),
  extractModel: nonEmptyString("EXTRACT_MODEL").pipe(Config.withDefault("deepseek/deepseek-v3.2")),
  mapModel: nonEmptyString("MAP_MODEL").pipe(Config.withDefault("deepseek/deepseek-v3.2")),
  reduceModel: nonEmptyString("REDUCE_MODEL").pipe(
    Config.withDefault("anthropic/claude-sonnet-5.5"),
  ),
  renderModel: nonEmptyString("RENDER_MODEL").pipe(Config.withDefault(DEFAULT_RENDER_MODEL)),
  queryTemperature: samplingTemperature("QUERY_TEMPERATURE", Option.some(0.3)),
  extractTemperature: samplingTemperature("EXTRACT_TEMPERATURE", Option.some(0.2)),
  mapTemperature: samplingTemperature("MAP_TEMPERATURE", Option.some(0)),
  reduceTemperature: samplingTemperature("REDUCE_TEMPERATURE", Option.none()),
  renderTemperature: samplingTemperature("RENDER_TEMPERATURE", Option.some(0.3)),
  queryReasoningEffort: reasoningEffort("QUERY_REASONING_EFFORT"),
  extractReasoningEffort: reasoningEffort("EXTRACT_REASONING_EFFORT"),
  mapReasoningEffort: reasoningEffort("MAP_REASONING_EFFORT"),
  reduceReasoningEffort: reasoningEffort("REDUCE_REASONING_EFFORT"),
  renderReasoningEffort: Config.literals(
    ["none", "low", "high", "max"] as const,
    "RENDER_REASONING_EFFORT",
  ).pipe(Config.withDefault<ReasoningEffort>("high"), Config.map(Option.some)),
  compileEnrichConcurrency: positiveInt("COMPILE_ENRICH_CONCURRENCY").pipe(Config.withDefault(20)),
  compileWriteConcurrency: positiveInt("COMPILE_WRITE_CONCURRENCY").pipe(Config.withDefault(3)),
  compileEmbedConcurrency: positiveInt("COMPILE_EMBED_CONCURRENCY").pipe(Config.withDefault(1)),
  compileDeriveRelatedLimit: positiveInt("COMPILE_DERIVE_RELATED_LIMIT").pipe(
    Config.withDefault(20),
  ),
  pipelineConcurrency: positiveInt("PIPELINE_CONCURRENCY").pipe(Config.withDefault(1)),
  embeddingModel: nonEmptyString("EMBEDDING_MODEL").pipe(
    Config.withDefault("qwen/qwen3-embedding-8b"),
  ),
  embeddingProviders: commaList("EMBEDDING_PROVIDERS", "deepinfra,nebius"),
  corsOrigins: commaList("CORS_ORIGINS", "http://localhost:5173"),
  publicWebUrl: Config.url("PUBLIC_WEB_URL").pipe(
    Config.withDefault(new URL("http://localhost:5173")),
  ),
  typstBinary: nonEmptyString("TYPST_BINARY").pipe(Config.withDefault("typst")),
  clientIpHeader: Config.option(
    nonEmptyString("CLIENT_IP_HEADER").pipe(Config.map((name) => name.trim().toLowerCase())),
  ),
  allowPrivateUrlFetch: Config.boolean("ALLOW_PRIVATE_URL_FETCH").pipe(Config.withDefault(false)),
  serverHost: nonEmptyString("HOST").pipe(Config.withDefault("0.0.0.0")),
  serverPort: Config.port("PORT").pipe(Config.withDefault(8787)),
}).pipe(
  Config.mapOrFail((config) => {
    if (config.webauthnOrigins.length === 0) {
      return Effect.fail(configError("WEBAUTHN_ORIGINS must contain at least one origin"));
    }
    if (config.publicWebUrl.protocol !== "http:" && config.publicWebUrl.protocol !== "https:") {
      return Effect.fail(configError("PUBLIC_WEB_URL must use HTTP or HTTPS"));
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
      configError(
        "STORAGE_BACKEND=r2 requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME",
      ),
    );
  }),
);

const MODEL_PROVIDER = /^([a-z][a-z0-9_]*):(.+)$/;

export type ResolvedModel = {
  readonly provider: Provider;
  readonly model: string;
  readonly price: ModelPrice | undefined;
};

export const resolveModel = (config: AppConfigShape, spec: string): ResolvedModel => {
  const match = MODEL_PROVIDER.exec(spec);
  const provider = match === null ? undefined : config.providers.get(match[1]!);
  if (match === null || provider === undefined)
    return {
      provider: {
        name: "openrouter",
        kind: "openrouter",
        url: config.openRouterApiUrl,
        apiKey: config.openRouterApiKey,
      },
      model: spec,
      price: config.modelPrices.get(spec),
    };
  return { provider, model: match[2]!, price: config.modelPrices.get(spec) };
};

export const missingModelKey = (config: AppConfigShape, spec: string) => {
  const { provider } = resolveModel(config, spec);
  if (provider.kind !== "openrouter" || Option.isSome(provider.apiKey)) return undefined;
  return provider.name === "openrouter"
    ? "OPENROUTER_API_KEY"
    : `PROVIDER_${provider.name.toUpperCase()}_KEY`;
};

export const notConfiguredDetail = (key: string) => `LLM service not configured (${key} missing)`;

const configuredModels = (config: AppConfigShape) => [
  config.queryModel,
  ...config.queryFallbackModels,
  config.extractModel,
  config.mapModel,
  config.reduceModel,
  config.renderModel,
  config.embeddingModel,
];

const checkModels = (config: AppConfigShape) =>
  Effect.forEach(configuredModels(config), (spec) => {
    const match = MODEL_PROVIDER.exec(spec);
    if (match === null) return Effect.void;
    if (!config.providers.has(match[1]!))
      return Effect.fail(
        configError(`model "${spec}" names provider "${match[1]}", which PROVIDERS does not list`),
      );
    if (!config.modelPrices.has(spec))
      return Effect.fail(
        configError(
          `MODEL_PRICES needs an entry for ${spec} (USD per million input/output tokens, e.g. ${spec}=0.6/2.5; 0/0 for a free local model)`,
        ),
      );
    return Effect.void;
  });

export const AppConfigLive = Layer.effect(
  AppConfig,
  Effect.gen(function* () {
    const base = yield* appConfig;
    const named = yield* Config.all((yield* providerNames).map(namedProvider));
    const config: AppConfigShape = {
      ...base,
      providers: new Map(named.map((provider) => [provider.name, provider])),
    };
    yield* checkModels(config);
    return config;
  }),
);
