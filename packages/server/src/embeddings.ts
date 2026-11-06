import { Buffer } from "node:buffer";

import { Context, Data, Effect, Layer, Schema } from "effect";

import { AppConfig, optionalRedactedValue, resolveModel } from "./config.ts";
import { CostLedger, type CostScope } from "./cost-ledger.ts";
import { StructuredLogger } from "./logging.ts";
import {
  ModelProviderError,
  priceCost,
  rateLimitRetry,
  responseDetail,
  RetryableModelError,
  retryAfterMs,
  transientRetry,
} from "./llm.ts";

const embeddingDimensions = 1024;
const embeddingTimeoutMs = 300_000;

type EmbeddingsShape = {
  readonly embed: (
    texts: readonly string[],
    scope?: CostScope,
  ) => Effect.Effect<readonly (readonly number[])[], EmbeddingBatchFailed>;
};

export class EmbeddingsService extends Context.Service<EmbeddingsService, EmbeddingsShape>()(
  "@great-minds/server/EmbeddingsService",
) {}

export class EmbeddingBatchFailed extends Data.TaggedError("EmbeddingBatchFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const isTimeoutError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  if ("cause" in error && error.cause !== error) return isTimeoutError(error.cause);
  return "name" in error && error.name === "TimeoutError";
};

export const vectorLiteral = (embedding: readonly number[]) => `[${embedding.join(",")}]`;

const truncateAndNormalize = (embedding: readonly number[]) => {
  const truncated = embedding.slice(0, embeddingDimensions);
  const norm = Math.hypot(...truncated);
  return norm === 0 ? truncated : truncated.map((value) => value / norm);
};

const decodeBase64Float32Le = (embedding: string): readonly number[] => {
  if (
    embedding.length === 0 ||
    embedding.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(embedding)
  ) {
    throw new ModelProviderError({
      message: "embedding provider returned invalid base64 vector data",
    });
  }
  const bytes = Buffer.from(embedding, "base64");
  if (bytes.length === 0 || bytes.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new ModelProviderError({
      message: "embedding provider returned invalid float32 vector bytes",
    });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoded = Array.from(
    { length: bytes.length / Float32Array.BYTES_PER_ELEMENT },
    (_, index) => view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true),
  );
  if (decoded.some((value) => !Number.isFinite(value))) {
    throw new ModelProviderError({
      message: "embedding provider returned non-finite float32 vector data",
    });
  }
  return decoded;
};

const decodeEmbedding = (embedding: string | readonly number[]): readonly number[] => {
  if (typeof embedding === "string") {
    return decodeBase64Float32Le(embedding);
  }
  if (embedding.length > 0 && embedding.every((value) => Number.isFinite(value))) {
    return embedding;
  }
  throw new ModelProviderError({ message: "embedding provider returned an invalid vector" });
};

const EmbeddingResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      embedding: Schema.Union([Schema.String, Schema.Array(Schema.Number)]),
    }),
  ),
  usage: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        prompt_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
        cost: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
});
const decodeEmbeddingResponse = Schema.decodeUnknownResult(EmbeddingResponse);

export const embeddingUsage = (value: unknown) => {
  const decoded = decodeEmbeddingResponse(value);
  const usage = decoded._tag === "Success" ? decoded.success.usage : undefined;
  return {
    promptTokens: usage?.prompt_tokens ?? undefined,
    cost: usage?.cost ?? undefined,
  };
};

export const parseEmbeddingResponse = (
  value: unknown,
  expectedCount: number,
): readonly (readonly number[])[] => {
  const decoded = decodeEmbeddingResponse(value);
  if (decoded._tag === "Failure") {
    throw new ModelProviderError({
      message: "embedding provider returned an unexpected response shape",
      issue: decoded.failure.issue,
    });
  }
  if (decoded.success.data.length !== expectedCount) {
    throw new ModelProviderError({
      message: "embedding provider returned an unexpected data shape",
    });
  }
  const indexed = decoded.success.data
    .map((item) => {
      if (!Number.isInteger(item.index) || item.index < 0 || item.index >= expectedCount) {
        throw new ModelProviderError({ message: "embedding provider returned an invalid index" });
      }
      return {
        index: item.index,
        embedding: truncateAndNormalize(decodeEmbedding(item.embedding)),
      };
    })
    .toSorted((left, right) => left.index - right.index);
  return indexed.map((item, index) => {
    if (item.index !== index) {
      throw new ModelProviderError({ message: "embedding provider returned duplicate indices" });
    }
    return item.embedding;
  });
};

const REQUEST_CHARS = 40_000;

export const embeddingRequestBody = (
  texts: readonly string[],
  model: string,
  providers: readonly string[] = [],
) => ({
  input: [...texts],
  model,
  encoding_format: "base64" as const,
  ...(providers.length === 0
    ? {}
    : { provider: { order: [...providers], allow_fallbacks: false } }),
});

export const sizedGroups = (texts: readonly string[], limit = REQUEST_CHARS) => {
  const groups: string[][] = [];
  let size = 0;
  for (const text of texts) {
    const last = groups.at(-1);
    if (last === undefined || (last.length > 0 && size + text.length > limit)) {
      groups.push([text]);
      size = text.length;
    } else {
      last.push(text);
      size += text.length;
    }
  }
  return groups;
};

export const EmbeddingsLive = Layer.effect(
  EmbeddingsService,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const ledger = yield* CostLedger;
    const logger = yield* StructuredLogger;
    const target = resolveModel(config, config.embeddingModel);
    const apiKey = optionalRedactedValue(target.provider.apiKey);
    const routing = target.provider.kind === "openrouter" ? config.embeddingProviders : [];
    const embedGroup = (texts: readonly string[], key: string | undefined) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(`${target.provider.url.replace(/\/$/, "")}/embeddings`, {
              method: "POST",
              headers: {
                ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
                "content-type": "application/json",
              },
              body: JSON.stringify(embeddingRequestBody(texts, target.model, routing)),
              signal: AbortSignal.any([signal, AbortSignal.timeout(embeddingTimeoutMs)]),
            }),
          catch: (cause) =>
            new ModelProviderError({
              message: "embedding provider request failed",
              cause,
              transient: true,
            }),
        });
        if (response.status === 429)
          return yield* new RetryableModelError({
            message: `embedding provider rate limited request (${yield* responseDetail(response)})`,
            retryAfterMs: retryAfterMs(response.headers),
          });
        if (!response.ok)
          return yield* new ModelProviderError({
            message: `embedding provider returned ${yield* responseDetail(response)}`,
            transient: response.status >= 500,
          });
        return yield* Effect.tryPromise({
          try: async () => {
            const json = await response.json();
            return {
              vectors: parseEmbeddingResponse(json, texts.length),
              usage: embeddingUsage(json),
            };
          },
          catch: (cause) =>
            cause instanceof ModelProviderError
              ? cause
              : new ModelProviderError({
                  message: "embedding provider returned an unreadable response",
                  cause,
                  transient: true,
                }),
        });
      }).pipe(
        Effect.retry(rateLimitRetry),
        Effect.retry(transientRetry),
        Effect.mapError(
          (error) => new EmbeddingBatchFailed({ message: error.message, cause: error }),
        ),
      );
    const record = (scope: CostScope | undefined, usage: ReturnType<typeof embeddingUsage>) => {
      const cost = usage.cost ?? priceCost(target.price, usage.promptTokens, 0);
      if (scope === undefined) return Effect.void;
      if (cost === undefined)
        return logger.warn("embedding_cost_unknown", {
          model: config.embeddingModel,
          phase: scope.phase,
          prompt_tokens: usage.promptTokens ?? -1,
        });
      return ledger.record({
        ...scope,
        model: config.embeddingModel,
        promptTokens: usage.promptTokens,
        costUsd: cost,
      });
    };
    return {
      embed: (texts, scope) =>
        apiKey === undefined && target.provider.kind === "openrouter"
          ? Effect.fail(
              new EmbeddingBatchFailed({ message: "OpenRouter API key is not configured" }),
            )
          : Effect.forEach(sizedGroups(texts), (group) =>
              embedGroup(group, apiKey).pipe(
                Effect.tap((result) => record(scope, result.usage)),
                Effect.map((result) => result.vectors),
              ),
            ).pipe(Effect.map((groups) => groups.flat())),
    } satisfies EmbeddingsShape;
  }),
);
