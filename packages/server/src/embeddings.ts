import { Buffer } from "node:buffer";

import { Context, Data, Effect, Layer, Schedule, Schema } from "effect";

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
});
const decodeEmbeddingResponse = Schema.decodeUnknownResult(EmbeddingResponse);

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
          return Effect.fail(
            new EmbeddingBatchFailed({ message: "OpenRouter API key is not configured" }),
          );
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
              throw new ModelProviderError({
                message: `embedding provider returned ${response.status}`,
              });
            }
            return parseEmbeddingResponse(await response.json(), texts.length);
          },
          catch: (cause) =>
            new EmbeddingBatchFailed({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }).pipe(Effect.retry(embeddingRetry));
      },
    } satisfies EmbeddingsShape;
  }),
);
