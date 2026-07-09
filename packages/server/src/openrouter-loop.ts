import type { ServerResponse } from "node:http";

import { OpenRouterClient } from "@effect/ai-openrouter";
import type { Generated } from "@effect/ai-openrouter";
import { Effect, Redacted, Stream } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { requireEnv } from "./env.ts";
import type { SseEvent } from "./api.ts";

type ChatMessage = Record<string, unknown>;
type ToolCall = Generated.ChatMessageToolCall;
type ToolDelta = Generated.ChatStreamingMessageToolCall;
type TokenUsage = Generated.ChatGenerationTokenUsage;

type RunState = {
  toolCalls: Map<number, {
    id: string;
    name: string;
    arguments: string;
  }>;
  usage?: TokenUsage;
};

const model = () => process.env.SPIKE_OPENROUTER_MODEL ?? "openai/gpt-4o-mini";

const tool = {
  type: "function",
  function: {
    name: "lookup_spike_context",
    description: "Return one short Great Minds spike fact for the assistant.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string" }
      },
      required: ["topic"],
      additionalProperties: false
    }
  }
} as const;

const toolResult = (argsJson: string) => {
  let topic = "spike";
  try {
    const args = JSON.parse(argsJson) as { topic?: string };
    topic = args.topic ?? topic;
  } catch {
    topic = "unparseable";
  }
  return `Great Minds spike context for ${topic}: preserve source grounding, keep replies brief, and report typed usage.`;
};

const writeSse = (response: ServerResponse, event: SseEvent) => {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
};

const upsertToolDelta = (state: RunState, delta: ToolDelta) => {
  const existing = state.toolCalls.get(delta.index) ?? {
    id: "",
    name: "",
    arguments: ""
  };
  if (delta.id) {
    existing.id = delta.id;
  }
  if (delta.function?.name) {
    existing.name = delta.function.name;
  }
  if (delta.function?.arguments) {
    existing.arguments += delta.function.arguments;
  }
  state.toolCalls.set(delta.index, existing);
};

const toToolCalls = (state: RunState): ToolCall[] =>
  [...state.toolCalls.values()].map((call, index) => ({
    id: call.id || `spike-tool-call-${index}`,
    type: "function",
    function: {
      name: call.name || "lookup_spike_context",
      arguments: call.arguments || "{}"
    }
  }));

const streamCompletion = (
  client: OpenRouterClient.Service,
  payload: Record<string, unknown>,
  response: ServerResponse,
  emitText: boolean
) =>
  Effect.gen(function* () {
    const state: RunState = { toolCalls: new Map() };
    const [, stream] = yield* client.createChatCompletionStream(payload as never);
    yield* Stream.runForEach(stream, (chunk) =>
      Effect.sync(() => {
        if (chunk.usage) {
          state.usage = chunk.usage;
        }
        for (const choice of chunk.choices) {
          const content = choice.delta.content;
          if (emitText && content) {
            writeSse(response, { type: "delta", text: content });
          }
          for (const toolCall of choice.delta.tool_calls ?? []) {
            upsertToolDelta(state, toolCall);
          }
        }
      })
    );
    return state;
  });

export const runOpenRouterSse = (response: ServerResponse) =>
  Effect.gen(function* () {
    const apiKey = requireEnv("OPENROUTER_API_KEY");
    const client = yield* OpenRouterClient.make({
      apiKey: Redacted.make(apiKey),
      siteTitle: "Great Minds Spike Zero"
    });

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You must call lookup_spike_context once, then answer in one concise sentence."
      },
      {
        role: "user",
        content:
          "Use the tool for Great Minds spike context, then say what the spike verified."
      }
    ];

    const first = yield* streamCompletion(
      client,
      {
        model: model(),
        messages,
        tools: [tool],
        tool_choice: "required",
        parallel_tool_calls: false,
        max_tokens: 80,
        temperature: 0
      },
      response,
      false
    );

    const toolCalls = toToolCalls(first);
    if (toolCalls.length === 0) {
      writeSse(response, {
        type: "error",
        text: "OpenRouter stream completed without a tool call"
      });
      return;
    }

    const toolMessages = toolCalls.map((call) => {
      const content = toolResult(call.function.arguments);
      writeSse(response, { type: "tool-call", name: call.function.name });
      writeSse(response, { type: "tool-result", name: call.function.name, text: content });
      return {
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content
      };
    });

    const second = yield* streamCompletion(
      client,
      {
        model: model(),
        messages: [
          ...messages,
          { role: "assistant", content: null, tool_calls: toolCalls },
          ...toolMessages
        ],
        max_tokens: 80,
        temperature: 0
      },
      response,
      true
    );

    const usage = second.usage ?? first.usage;
    writeSse(response, {
      type: "finish",
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      totalTokens: usage?.total_tokens,
      costUsd: null
    });
  }).pipe(Effect.provide(FetchHttpClient.layer));
