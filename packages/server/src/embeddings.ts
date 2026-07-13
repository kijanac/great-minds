import { Buffer } from "node:buffer";

import { Context, Effect, Layer, Option, Redacted } from "effect";

import { AppConfig } from "./config.ts";
import { ModelProviderError } from "./llm.ts";

const embeddingDimensions = 1024;
const embeddingTimeoutMs = 300_000;
const maxEmbeddingRetries = 3;

type EmbeddingsShape = {
  readonly embed: (texts: readonly string[]) => Promise<readonly (readonly number[])[]>;
};

export class EmbeddingsService extends Context.Service<EmbeddingsService, EmbeddingsShape>()(
  "@great-minds/server/EmbeddingsService",
) {}

const optionalRedactedValue = (value: Option.Option<Redacted.Redacted<string>>) =>
  Option.match(value, {
    onNone: () => undefined,
    onSome: Redacted.value,
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const decodeEmbedding = (embedding: unknown): readonly number[] => {
  if (typeof embedding === "string") {
    return decodeBase64Float32Le(embedding);
  }
  if (
    Array.isArray(embedding) &&
    embedding.length > 0 &&
    embedding.every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    return embedding;
  }
  throw new ModelProviderError("embedding provider returned an invalid vector");
};

export const parseEmbeddingResponse = (
  value: unknown,
  expectedCount: number,
): readonly (readonly number[])[] => {
  if (typeof value !== "object" || value === null) {
    throw new ModelProviderError("embedding provider returned a non-object response");
  }
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new ModelProviderError("embedding provider returned an unexpected data shape");
  }
  const indexed = data.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new ModelProviderError("embedding provider returned an invalid item");
    }
    const embedding = (item as Record<string, unknown>).embedding;
    const index = (item as Record<string, unknown>).index;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= expectedCount) {
      throw new ModelProviderError("embedding provider returned an invalid index");
    }
    return { index: index as number, embedding: truncateAndNormalize(decodeEmbedding(embedding)) };
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
      embed: async (texts) => {
        if (apiKey === undefined) {
          throw new ModelProviderError("OpenRouter API key is not configured");
        }
        for (let attempt = 1; attempt <= maxEmbeddingRetries; attempt += 1) {
          try {
            const response = await fetch(`${config.openRouterApiUrl.replace(/\/$/, "")}/embeddings`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(embeddingRequestBody(texts, config.embeddingModel)),
              signal: AbortSignal.timeout(embeddingTimeoutMs),
            });
            if (!response.ok) {
              throw new ModelProviderError(`embedding provider returned ${response.status}`);
            }
            return parseEmbeddingResponse(await response.json(), texts.length);
          } catch (error) {
            if (attempt === maxEmbeddingRetries) {
              throw error;
            }
            await sleep(2 ** attempt * 1000);
          }
        }
        throw new Error("embedding retry loop exited without resolution");
      },
    } satisfies EmbeddingsShape;
  }),
);
