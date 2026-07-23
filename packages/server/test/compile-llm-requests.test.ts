import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  assignmentsResponseFormat,
  codePointLength,
  decodeCompileJsonCompletion,
  extractResponseFormat,
  normalizePythonWhitespace,
  registryResponseFormat,
} from "../src/compile-llm-core.ts";
import { completionRequestBody, type LlmMessage } from "../src/llm.ts";

type CassetteEntry = {
  readonly sequence: number;
  readonly requestBody: {
    readonly messages: readonly LlmMessage[];
  };
};

const cassette = JSON.parse(
  await readFile(new URL("../../goldens/cassettes/compile.json", import.meta.url), "utf8"),
) as { readonly entries: readonly CassetteEntry[] };

const entry = (sequence: number) => {
  const found = cassette.entries.find((candidate) => candidate.sequence === sequence);
  if (found === undefined) throw new Error(`cassette entry ${sequence} is missing`);
  return found;
};

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
};

const sortedKeyHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

const expectCassetteRequest = (
  sequence: number,
  input: Parameters<typeof completionRequestBody>[0],
) => {
  const recorded = entry(sequence).requestBody;
  const composed = completionRequestBody(input);
  expect(sortedKeyHash(composed)).toBe(sortedKeyHash(recorded));
  expect(composed).toEqual(recorded);
};

describe("compile LLM request composition", () => {
  it("extract matches a real source-card cassette request at the raw tier", () => {
    const recorded = entry(1).requestBody;
    expectCassetteRequest(1, {
      model: "deepseek/deepseek-v3.2",
      messages: recorded.messages,
      temperature: 0.2,
      responseFormat: extractResponseFormat({
        thematicHint: "",
        kinds: ["person", "event", "organization", "concept"],
        enrichedFields: [],
      }),
      requestProfile: "compile",
    });
  });

  it("synthesize matches a real JSON-object cassette request at the raw tier", () => {
    const recorded = entry(11).requestBody;
    expectCassetteRequest(11, {
      model: "deepseek/deepseek-v3.2",
      messages: recorded.messages,
      temperature: 0.3,
      responseFormat: "json_object",
      requestProfile: "compile",
    });
  });

  it("canonical registry and assignment match real strict-schema cassette requests", () => {
    const registry = entry(44).requestBody;
    expectCassetteRequest(44, {
      model: "anthropic/claude-sonnet-4.6",
      messages: registry.messages,
      temperature: 0.2,
      responseFormat: registryResponseFormat,
      requestProfile: "compile",
    });

    const assignment = entry(45).requestBody;
    expectCassetteRequest(45, {
      model: "anthropic/claude-sonnet-4.6",
      messages: assignment.messages,
      temperature: 0.1,
      responseFormat: assignmentsResponseFormat,
      requestProfile: "compile",
    });
  });

  it("render and validation cleanup match real JSON-object cassette requests", () => {
    const render = entry(47).requestBody;
    expectCassetteRequest(47, {
      model: "qwen/qwen3.6-plus",
      messages: render.messages,
      temperature: 0.3,
      responseFormat: "json_object",
      requestProfile: "compile",
    });

    const cleanup = entry(67).requestBody;
    expectCassetteRequest(67, {
      model: "anthropic/claude-sonnet-4.6",
      messages: cleanup.messages,
      temperature: 0.1,
      responseFormat: "json_object",
      requestProfile: "compile",
    });
  });
});

describe("compile structured-output decoding", () => {
  it("accepts the JSON fencing tolerated by Python", () => {
    expect(
      decodeCompileJsonCompletion("fixture-model", {
        text: '```json\n{"topics":[]}\n```',
        finishReason: "stop",
      }),
    ).toEqual({ topics: [] });
  });

  it("keeps malformed JSON loud", () => {
    expect(() =>
      decodeCompileJsonCompletion("fixture-model", {
        text: "{not-json}",
        finishReason: "stop",
      }),
    ).toThrow(SyntaxError);
  });

  it("keeps token-limit truncation loud before parsing", () => {
    expect(() =>
      decodeCompileJsonCompletion("fixture-model", {
        text: '{"topics":[]}',
        finishReason: "length",
      }),
    ).toThrow("fixture-model output hit the token limit (finish_reason=length) and was truncated");
  });
});

describe("Python text-kernel alignment", () => {
  it("normalizes Python Unicode whitespace without treating BOM as whitespace", () => {
    expect(normalizePythonWhitespace(" alpha\u0085\u001cbeta\u3000gamma ")).toBe(
      "alpha beta gamma",
    );
    expect(normalizePythonWhitespace("alpha\ufeffbeta")).toBe("alpha\ufeffbeta");
  });

  it("counts Unicode code points rather than UTF-16 code units", () => {
    expect(codePointLength("a😀b")).toBe(3);
  });
});
