import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  articleResponseFormat,
  assignmentsResponseFormat,
  cleanupResponseFormat,
  codePointLength,
  extractResponseFormat,
  normalizePythonWhitespace,
  registryResponseFormat,
  synthesisResponseFormat,
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

const expectRecordedPrompt = (
  sequence: number,
  input: Parameters<typeof completionRequestBody>[0],
) => {
  const recorded = entry(sequence).requestBody;
  expect(completionRequestBody({ ...input, messages: recorded.messages })).toEqual({
    ...recorded,
    response_format: input.responseFormat,
    provider: { require_parameters: true },
  });
};

describe("compile LLM request composition", () => {
  it("sends every recorded compile prompt with a strict schema to capable hosts only", () => {
    expectRecordedPrompt(1, {
      model: "deepseek/deepseek-v3.2",
      messages: [],
      temperature: 0.2,
      responseFormat: extractResponseFormat({
        thematicHint: "",
        kinds: ["person", "event", "organization", "concept"],
        webSearch: false,
        enrichedFields: [],
      }),
      requestProfile: "compile",
    });
    expectRecordedPrompt(11, {
      model: "deepseek/deepseek-v3.2",
      messages: [],
      temperature: 0.3,
      responseFormat: synthesisResponseFormat,
      requestProfile: "compile",
    });
    expectRecordedPrompt(53, {
      model: "anthropic/claude-sonnet-4.6",
      messages: [],
      temperature: 0.2,
      responseFormat: registryResponseFormat,
      requestProfile: "compile",
    });
    expectRecordedPrompt(54, {
      model: "anthropic/claude-sonnet-4.6",
      messages: [],
      temperature: 0.1,
      responseFormat: assignmentsResponseFormat,
      requestProfile: "compile",
    });
    expectRecordedPrompt(55, {
      model: "qwen/qwen3.6-plus",
      messages: [],
      temperature: 0.3,
      responseFormat: articleResponseFormat,
      requestProfile: "compile",
    });
    expectRecordedPrompt(78, {
      model: "anthropic/claude-sonnet-4.6",
      messages: [],
      temperature: 0.1,
      responseFormat: cleanupResponseFormat,
      requestProfile: "compile",
    });
  });

  it("omits temperature for models whose hosts reject one", () => {
    expect(
      completionRequestBody({
        model: "anthropic/claude-sonnet-5.5",
        messages: [],
        responseFormat: cleanupResponseFormat,
        requestProfile: "compile",
      }),
    ).toEqual({
      model: "anthropic/claude-sonnet-5.5",
      messages: [],
      response_format: cleanupResponseFormat,
      usage: { include: true },
      provider: { require_parameters: true },
    });
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
