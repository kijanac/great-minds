import { Buffer } from "node:buffer";

import { Context, Effect, Layer, Schedule, Schema } from "effect";

import { AppConfig, optionalRedactedValue } from "./config.ts";
import { ModelProviderError } from "./llm.ts";

const embeddingDimensions = 1024;
const embeddingTimeoutMs = 300_000;
const embeddingRetry = { schedule: Schedule.exponential("2 seconds"), times: 2 } as const;

type EmbeddingsShape = {
  readonly embed: (texts: readonly string[]) => Effect.Effect<readonly (readonly number[])[], EmbeddingBatchFailed>;
};

export class EmbeddingsService extends Context.Service<EmbeddingsService, EmbeddingsShape>()(
  "@great-minds/server/EmbeddingsService",
) {}

export class EmbeddingBatchFailed extends Error {
  readonly _tag = "EmbeddingBatchFailed";
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = this._tag;
    this.cause = cause;
  }
}

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
    throw new ModelProviderError("embedding provider returned invalid base64 vector data");
  }
  const bytes = Buffer.from(embedding, "base64");
  if (bytes.length === 0 || bytes.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new ModelProviderError("embedding provider returned invalid float32 vector bytes");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoded = Array.from(
    { length: bytes.length / Float32Array.BYTES_PER_ELEMENT },
    (_, index) => view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true),
  );
  if (decoded.some((value) => !Number.isFinite(value))) {
    throw new ModelProviderError("embedding provider returned non-finite float32 vector data");
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
  throw new ModelProviderError("embedding provider returned an invalid vector");
};

const EmbeddingResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      embedding: Schema.Union([Schema.String, Schema.Array(Schema.Number)]),
    }),
  ),
});
const decodeEmbeddingResponse = Schema.decodeUnknownSync(EmbeddingResponse);

export const parseEmbeddingResponse = (
  value: unknown,
  expectedCount: number,
): readonly (readonly number[])[] => {
  let response: typeof EmbeddingResponse.Type;
  try {
    response = decodeEmbeddingResponse(value);
  } catch {
    throw new ModelProviderError("embedding provider returned an unexpected response shape");
  }
  if (response.data.length !== expectedCount) {
    throw new ModelProviderError("embedding provider returned an unexpected data shape");
  }
  const indexed = response.data.map((item) => {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= expectedCount) {
      throw new ModelProviderError("embedding provider returned an invalid index");
    }
    return { index: item.index, embedding: truncateAndNormalize(decodeEmbedding(item.embedding)) };
  });
  const byIndex = new Map(indexed.map((item) => [item.index, item.embedding]));
  if (byIndex.size !== expectedCount) {
    throw new ModelProviderError("embedding provider returned duplicate indices");
  }
  return Array.from({ length: expectedCount }, (_, index) => {
    const embedding = byIndex.get(index);
    if (embedding === undefined) {
      throw new ModelProviderError("embedding provider omitted an index");
    }
    return embedding;
  });
};

export const embeddingRequestBody = (texts: readonly string[], model: string) => ({
  input: [...texts],
  model,
  encoding_format: "base64" as const,
});

export const EmbeddingsLive = Layer.effect(
  EmbeddingsService,
  Effect.map(AppConfig, (config) => {
    const apiKey = optionalRedactedValue(config.openRouterApiKey);
    return {
      embed: (texts) => {
        if (apiKey === undefined) {
          return Effect.fail(new EmbeddingBatchFailed(new ModelProviderError("OpenRouter API key is not configured")));
        }
        return Effect.tryPromise({
          try: async (signal) => {
            const response = await fetch(`${config.openRouterApiUrl.replace(/\/$/, "")}/embeddings`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(embeddingRequestBody(texts, config.embeddingModel)),
              signal: AbortSignal.any([signal, AbortSignal.timeout(embeddingTimeoutMs)]),
            });
            if (!response.ok) {
              throw new ModelProviderError(`embedding provider returned ${response.status}`);
            }
            return parseEmbeddingResponse(await response.json(), texts.length);
          },
          catch: (error) => new EmbeddingBatchFailed(error),
        }).pipe(Effect.retry(embeddingRetry));
      },
    } satisfies EmbeddingsShape;
  }),
);
