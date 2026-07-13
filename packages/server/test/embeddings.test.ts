import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { embeddingRequestBody, parseEmbeddingResponse } from "../src/embeddings.ts";
import { ModelProviderError } from "../src/llm.ts";

const base64Float32Le = (...values: readonly number[]) => {
  const bytes = Buffer.alloc(values.length * Float32Array.BYTES_PER_ELEMENT);
  values.forEach((value, index) =>
    bytes.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT),
  );
  return bytes.toString("base64");
};

describe("embedding provider protocol", () => {
  it("matches the openai-python request body order and base64 encoding format", () => {
    expect(JSON.stringify(embeddingRequestBody(["alpha", "beta"], "embedding/test"))).toBe(
      '{"input":["alpha","beta"],"model":"embedding/test","encoding_format":"base64"}',
    );
  });

  it("decodes little-endian float32 base64 vectors and preserves provider indices", () => {
    const parsed = parseEmbeddingResponse(
      {
        data: [
          { index: 1, embedding: [0, 2] },
          { index: 0, embedding: base64Float32Le(3, 4) },
        ],
      },
      2,
    );

    expect(parsed[0]?.[0]).toBeCloseTo(0.6);
    expect(parsed[0]?.[1]).toBeCloseTo(0.8);
    expect(parsed[1]).toEqual([0, 1]);
  });

  it("rejects malformed provider vectors with a typed provider error", () => {
    expect(() =>
      parseEmbeddingResponse({ data: [{ index: 0, embedding: "not base64" }] }, 1),
    ).toThrow(ModelProviderError);
  });
});
