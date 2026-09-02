import { describe, expect, it } from "vitest";

import { parseOpenRouterStream, type ModelStreamPart } from "../src/llm.ts";

const sseResponse = (blocks: readonly string[], newline = "\n") =>
  new Response(
    new Blob([
      blocks.map((block) => `${block.replaceAll("\n", newline)}${newline}${newline}`).join(""),
    ]).stream(),
    { headers: { "content-type": "text/event-stream" } },
  );

const collect = async (response: Response) => {
  const parts: ModelStreamPart[] = [];
  for await (const part of parseOpenRouterStream(response)) {
    parts.push(part);
  }
  return parts;
};

describe("openrouter stream protocol", () => {
  it("decodes tokens, tool-call deltas, and trailing usage from a realistic transcript", async () => {
    const parts = await collect(
      sseResponse([
        ": OPENROUTER PROCESSING",
        'data: {"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"m","provider":"P","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null,"native_finish_reason":null,"logprobs":null}]}',
        'data: {"id":"gen-1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
        'data: {"id":"gen-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_document","arguments":"{\\"pa"}}]},"finish_reason":null}]}',
        'data: {"id":"gen-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":1}"}}]},"finish_reason":"tool_calls"}]}',
        'data: {"id":"gen-1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"cost":0.001}}',
        "data: [DONE]",
      ]),
    );

    expect(parts).toEqual([
      { type: "token", text: "Hello" },
      {
        type: "tool_call_delta",
        delta: { index: 0, id: "call_1", name: "read_document", argumentsDelta: '{"pa' },
      },
      {
        type: "tool_call_delta",
        delta: { index: 0, id: undefined, name: undefined, argumentsDelta: 'th":1}' },
      },
      {
        type: "finish",
        finishReason: "tool_calls",
        generationId: "gen-1",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.001 },
      },
    ]);
  });

  it("treats null usage and absent choices as interim frames", async () => {
    const parts = await collect(
      sseResponse([
        'data: {"id":"gen-2","usage":null,"choices":[{"index":0,"delta":{"content":"A"},"finish_reason":null}]}',
        'data: {"id":"gen-2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
      ]),
    );

    expect(parts).toEqual([
      { type: "token", text: "A" },
      { type: "finish", finishReason: "stop", generationId: "gen-2", usage: undefined },
    ]);
  });

  it.each(["\r\n", "\r"])("frames events delimited by %j like LF", async (newline) => {
    const parts = await collect(
      sseResponse(
        [
          'data: {"id":"gen-3","choices":[{"index":0,"delta":{"content":"multi"},"finish_reason":null}]}',
          'data: {"id":"gen-3","choices":[{"index":0,"delta":{"content":"line"},\ndata: "finish_reason":"stop"}]}',
          "data: [DONE]",
        ],
        newline,
      ),
    );

    expect(parts).toEqual([
      { type: "token", text: "multi" },
      { type: "token", text: "line" },
      { type: "finish", finishReason: "stop", generationId: "gen-3", usage: undefined },
    ]);
  });

  it("rejects a frame whose declared fields have the wrong shape", async () => {
    await expect(
      collect(sseResponse(['data: {"choices":[{"delta":{"content":42}}]}', "data: [DONE]"])),
    ).rejects.toThrow();
  });
});
