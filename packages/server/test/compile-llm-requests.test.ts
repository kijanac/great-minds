import { describe, expect, it } from "vitest";

import { normalizePythonWhitespace } from "../src/compile-extract.ts";
import { completionRequestBody } from "../src/llm.ts";

const articleFormat = {
  type: "json_schema",
  json_schema: {
    name: "article",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { body: { type: "string" } },
      required: ["body"],
    },
  },
} as const;

describe("compile LLM request composition", () => {
  it("omits temperature for models whose hosts reject one", () => {
    expect(
      completionRequestBody({
        model: "anthropic/claude-sonnet-5.5",
        messages: [],
        responseFormat: articleFormat,
        requestProfile: "compile",
      }),
    ).toEqual({
      model: "anthropic/claude-sonnet-5.5",
      messages: [],
      response_format: articleFormat,
      usage: { include: true },
      provider: { require_parameters: true },
    });
  });
});

describe("compile reasoning effort", () => {
  it("sends the requested reasoning effort alongside the strict schema", () => {
    expect(
      completionRequestBody({
        model: "z-ai/glm-5.3",
        messages: [],
        temperature: 0.3,
        reasoningEffort: "high",
        responseFormat: articleFormat,
        requestProfile: "compile",
      }),
    ).toEqual({
      model: "z-ai/glm-5.3",
      messages: [],
      temperature: 0.3,
      reasoning: { effort: "high" },
      response_format: articleFormat,
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
});
