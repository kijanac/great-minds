import { Cause, Effect, Exit, Fiber, Result, Stream } from "effect";
import { TestClock } from "effect/testing";
import { assert, describe, expect, it } from "vitest";

import { parseOpenRouterStream, type ModelStreamPart } from "../src/llm.ts";

const sseResponse = (blocks: readonly string[], newline = "\n") =>
  new Response(
    new Blob([
      blocks.map((block) => `${block.replaceAll("\n", newline)}${newline}${newline}`).join(""),
    ]).stream(),
    { headers: { "content-type": "text/event-stream" } },
  );

const collect = (response: Response) =>
  Effect.runPromise(Stream.runCollect(parseOpenRouterStream(response)));

const recordParts = (response: Response, parts: ModelStreamPart[]) =>
  Stream.runForEach(parseOpenRouterStream(response), (part) =>
    Effect.sync(() => {
      parts.push(part);
    }),
  );

const collectUntilFailure = (response: Response) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const parts: ModelStreamPart[] = [];
      const exit = yield* Effect.exit(recordParts(response, parts));
      return { parts, exit };
    }),
  );

const failureTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>) => {
  assert(Exit.isFailure(exit));
  const error = Cause.findError(exit.cause);
  assert(Result.isSuccess(error));
  return error.success._tag;
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

  it("preserves a successful finish through interim frames and clean EOF", async () => {
    const parts = await collect(
      sseResponse([
        'data: {"id":"gen-2","usage":null,"choices":[{"index":0,"delta":{"content":"A"},"finish_reason":null}]}',
        'data: {"id":"gen-2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: {"usage":null}',
        'data: {"choices":[{"delta":{},"finish_reason":null}]}',
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

  it("ignores retry directives and unnamed event fields the way the data-only protocol expects", async () => {
    const parts = await collect(
      sseResponse([
        "retry: 3000",
        'event: ping\ndata: {"id":"gen-4","choices":[{"index":0,"delta":{"content":"kept"},"finish_reason":"stop"}]}',
        "data: [DONE]",
      ]),
    );

    expect(parts).toEqual([
      { type: "token", text: "kept" },
      { type: "finish", finishReason: "stop", generationId: "gen-4", usage: undefined },
    ]);
  });

  it.each([
    { ending: "EOF", suffix: [] },
    { ending: "DONE without a finish reason", suffix: ["data: [DONE]"] },
    {
      ending: "provider error",
      suffix: [
        'data: {"error":{"code":"server_error","message":"Disconnected"},"choices":[{"delta":{},"finish_reason":"error"}]}',
      ],
    },
  ])(
    "rejects $ending without discarding partial output or authorizing retry",
    async ({ suffix }) => {
      const { parts, exit } = await collectUntilFailure(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":null}]}',
          ...suffix,
        ]),
      );
      expect(parts).toEqual([{ type: "token", text: "Partial" }]);
      expect(failureTag(exit)).toBe("ModelProviderError");
    },
  );

  it("does not classify an accepted response with no body as a safe retry", async () => {
    const { exit } = await collectUntilFailure(new Response(null));
    expect(failureTag(exit)).toBe("ModelProviderError");
  });

  it.each(["", "Partial answer"])(
    "does not classify an accepted stream stall after %j as a safe retry",
    async (partial) => {
      let enqueue!: (chunk: Uint8Array) => void;
      const pulls: Array<() => void> = [];
      const nextPull = () =>
        new Promise<void>((resolve) => {
          pulls.push(resolve);
        });
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            enqueue = (chunk) => controller.enqueue(chunk);
          },
          pull() {
            pulls.shift()?.();
          },
        },
        { highWaterMark: 0 },
      );
      const parts: ModelStreamPart[] = [];
      let settled = false;
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const firstPull = nextPull();
          const fiber = yield* Effect.forkChild(
            Effect.exit(recordParts(new Response(body), parts)).pipe(
              Effect.tap(() => Effect.sync(() => (settled = true))),
            ),
          );
          yield* Effect.promise(() => firstPull);
          if (partial.length > 0) {
            const secondPull = nextPull();
            enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: partial } }] })}\n\n`,
              ),
            );
            yield* Effect.promise(() => secondPull);
          }
          yield* TestClock.adjust("29999 millis");
          expect(settled).toBe(false);
          yield* TestClock.adjust("1 millis");
          return yield* Fiber.join(fiber);
        }).pipe(Effect.provide(TestClock.layer())),
      );
      expect(parts).toEqual(partial.length > 0 ? [{ type: "token", text: partial }] : []);
      expect(failureTag(outcome)).toBe("ModelProviderError");
    },
  );

  it("rejects a frame whose declared fields have the wrong shape", async () => {
    const { exit } = await collectUntilFailure(
      sseResponse(['data: {"choices":[{"delta":{"content":42}}]}', "data: [DONE]"]),
    );
    expect(failureTag(exit)).toBe("ModelProviderError");
  });
});
