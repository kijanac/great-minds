import { describe, expect, it } from "vitest";

import { quoteLocator } from "../src/compile-extract.ts";
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

describe("locating an extracted quote in its source", () => {
  const paragraphs = [
    { index: 0, body: "The strikes of 1896 drew **30,000** workers,\nand later ones grew." },
    {
      index: 1,
      body: "Banditry spread behind the lines; the rear was never quiet, and the supply columns moved only under heavy guard through the winter.",
    },
  ];

  const locate = quoteLocator(paragraphs);

  it("keeps a verbatim quote exactly as given", () => {
    expect(locate("the rear was\nnever quiet,")).toEqual({
      chunkIndex: 1,
      quote: "the rear was\nnever quiet,",
    });
  });

  it("finds a quote despite markup, case, punctuation and line breaks, and returns the source's text", () => {
    expect(locate("the strikes of 1896 drew 30,000 workers and later ones grew")).toEqual({
      chunkIndex: 0,
      quote: "The strikes of 1896 drew **30,000** workers, and later ones grew",
    });
  });

  it("places a slightly reworded quote in its paragraph and quotes the source's wording", () => {
    expect(
      locate(
        "the rear was never quiet, and the supply convoys moved only under heavy guard through the winter",
      ),
    ).toEqual({
      chunkIndex: 1,
      quote:
        "the rear was never quiet, and the supply columns moved only under heavy guard through the winter",
    });
  });

  it("anchors a quote that runs over a paragraph break to the paragraph where it starts", () => {
    expect(locate("and later ones grew. Banditry spread behind the lines")).toEqual({
      chunkIndex: 0,
      quote: "and later ones grew. Banditry spread behind the lines",
    });
    expect(locate("later ones grew banditry spread")?.chunkIndex).toBe(0);
  });

  it("leaves a short quote with a changed word unplaced", () => {
    expect(locate("Banditry spread behind the lines and the rear")).toBeUndefined();
  });

  it("does not place a quote the source does not contain", () => {
    expect(locate("The peasants seized the estates in 1917")).toBeUndefined();
    expect(locate(" — ")).toBeUndefined();
  });
});
