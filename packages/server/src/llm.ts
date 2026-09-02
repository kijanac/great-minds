import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";

import { AppConfig } from "./config.ts";

export type LlmTextContentPart = {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: { readonly type: "ephemeral" };
};

export type LlmTextMessage = {
  readonly role: "system" | "user" | "assistant";
  readonly content: string | null | readonly LlmTextContentPart[];
  readonly tool_calls?: readonly LlmAssistantToolCall[];
};

export type LlmToolMessage = {
  readonly role: "tool";
  readonly tool_call_id: string;
  readonly content: string;
};

export type LlmMessage = LlmTextMessage | LlmToolMessage;

export type LlmToolDefinition = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
};

export type LlmAssistantToolCall = {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
};

export type LlmToolCallDelta = {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly argumentsDelta?: string;
};

export type LlmUsage = {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cost?: number;
};

export type ModelStreamPart =
  | {
      readonly type: "token";
      readonly text: string;
    }
  | {
      readonly type: "tool_call_delta";
      readonly delta: LlmToolCallDelta;
    }
  | {
      readonly type: "finish";
      readonly finishReason: string | null;
      readonly generationId?: string;
      readonly usage?: LlmUsage;
    };

export type StreamChatInput = {
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly LlmToolDefinition[];
  readonly temperature: number;
};

export type CompleteInput = {
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly temperature: number;
  readonly responseFormat?: "json_object" | Record<string, unknown>;
  readonly requestProfile?: "default" | "compile";
};

export type ModelCompletion = {
  readonly text: string;
  readonly finishReason?: string | null;
  readonly generationId?: string;
  readonly usage?: LlmUsage;
};

type LanguageModelShape = {
  readonly hasApiKey: boolean;
  readonly streamChat: (input: StreamChatInput) => AsyncIterable<ModelStreamPart>;
  readonly complete: (input: CompleteInput) => Promise<ModelCompletion>;
};

export class LanguageModel extends Context.Service<LanguageModel, LanguageModelShape>()(
  "@great-minds/server/LanguageModel",
) {}

export class RetryableModelError extends Error {
  readonly retryAfterMs?: number;

  constructor(message: string, options: { readonly retryAfterMs?: number } = {}) {
    super(message);
    this.name = "RetryableModelError";
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class ModelProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProviderError";
  }
}

export const isRetryableModelError = (error: unknown) => error instanceof RetryableModelError;

const streamChunkTimeoutMs = 30_000;
const rateLimitRetries = 6;
const maxRateLimitBackoffMs = 60_000;

const optionalRedactedValue = (value: Option.Option<Redacted.Redacted<string>>) =>
  Option.match(value, {
    onNone: () => undefined,
    onSome: Redacted.value,
  });

const openRouterHeaders = (apiKey: string) => ({
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
});

const WireUsage = Schema.Struct({
  prompt_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  completion_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  total_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  cost: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});

const WireToolCallDelta = Schema.Struct({
  index: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  function: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.optionalKey(Schema.NullOr(Schema.String)),
        arguments: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const WireStreamChunk = Schema.Struct({
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  usage: Schema.optionalKey(Schema.NullOr(WireUsage)),
  choices: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          delta: Schema.optionalKey(
            Schema.NullOr(
              Schema.Struct({
                content: Schema.optionalKey(Schema.NullOr(Schema.String)),
                tool_calls: Schema.optionalKey(Schema.NullOr(Schema.Array(WireToolCallDelta))),
              }),
            ),
          ),
          finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});
const decodeWireStreamChunk = Schema.decodeUnknownSync(WireStreamChunk);

const WireCompletion = Schema.Struct({
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  usage: Schema.optionalKey(Schema.NullOr(WireUsage)),
  choices: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          message: Schema.optionalKey(
            Schema.NullOr(
              Schema.Struct({ content: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
            ),
          ),
          finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});
const decodeWireCompletion = Schema.decodeUnknownSync(WireCompletion);

const usageFrom = (usage: typeof WireUsage.Type | null | undefined): LlmUsage | undefined => {
  if (usage === undefined || usage === null) {
    return undefined;
  }
  const promptTokens = usage.prompt_tokens ?? undefined;
  const completionTokens = usage.completion_tokens ?? undefined;
  const totalTokens = usage.total_tokens ?? undefined;
  const cost = usage.cost ?? undefined;
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined &&
    cost === undefined
  ) {
    return undefined;
  }
  return { promptTokens, completionTokens, totalTokens, cost };
};

const readWithTimeout = async <A>(promise: Promise<A>) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new RetryableModelError("model stream stalled"));
        }, streamChunkTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

const safeResponseText = async (response: Response) => {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return "";
  }
};

const postChat = async (apiUrl: string, apiKey: string, body: unknown) => {
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: openRouterHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (response.status === 429) {
    throw new RetryableModelError("model provider rate limited request", {
      retryAfterMs: retryAfterMs(response.headers),
    });
  }
  if (!response.ok) {
    const detail = await safeResponseText(response);
    throw new ModelProviderError(`model provider returned ${response.status}: ${detail}`);
  }
  return response;
};

const retryAfterMs = (headers: Headers) => {
  const header = headers.get("retry-after") ?? headers.get("Retry-After");
  if (header === null || header.length === 0) {
    return undefined;
  }
  const seconds = Number.parseFloat(header);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const postChatWithRateLimitRetry = async (apiUrl: string, apiKey: string, body: unknown) => {
  let rateLimitAttempts = 0;
  while (true) {
    try {
      return await postChat(apiUrl, apiKey, body);
    } catch (error) {
      if (!(error instanceof RetryableModelError)) {
        throw error;
      }
      rateLimitAttempts += 1;
      if (rateLimitAttempts > rateLimitRetries) {
        throw error;
      }
      const fallbackMs = Math.min(maxRateLimitBackoffMs, 2 ** rateLimitAttempts * 1000);
      await sleep(error.retryAfterMs ?? fallbackMs);
    }
  }
};

export const completionRequestBody = (input: CompleteInput) => {
  const responseFormat =
    typeof input.responseFormat === "string"
      ? { type: input.responseFormat }
      : input.responseFormat;
  const common = {
    model: input.model,
    messages: input.messages,
    temperature: input.temperature,
    response_format: responseFormat,
  };
  if (input.requestProfile === "compile") {
    return {
      ...common,
      usage: { include: true },
    };
  }
  return {
    ...common,
    stream: false,
    usage: { include: true },
    provider: {
      allow_fallbacks: true,
      sort: "throughput",
    },
  };
};

const SSE_FRAME_BOUNDARY = /\r\n\r\n|\n\n|\r\r/;

const parseDataLines = (block: string) =>
  block
    .split(/\r\n|\n|\r/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");

const toolCallDeltas = (
  toolCalls: readonly (typeof WireToolCallDelta.Type)[] | null | undefined,
): readonly LlmToolCallDelta[] =>
  (toolCalls ?? []).map((item) => ({
    index: item.index ?? 0,
    id: item.id ?? undefined,
    name: item.function?.name ?? undefined,
    argumentsDelta: item.function?.arguments ?? undefined,
  }));

export async function* parseOpenRouterStream(response: Response): AsyncIterable<ModelStreamPart> {
  if (response.body === null) {
    throw new RetryableModelError("model provider returned no stream body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finishReason: string | null = null;
  let generationId: string | undefined;
  let usage: LlmUsage | undefined;

  while (true) {
    const { done, value } = await readWithTimeout(reader.read());
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const boundary = SSE_FRAME_BOUNDARY.exec(buffer);
      if (boundary === null) {
        break;
      }
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = parseDataLines(block);
      if (data.length === 0 || data === "[DONE]") {
        continue;
      }
      const chunk = decodeWireStreamChunk(JSON.parse(data));
      if (chunk.id !== undefined && chunk.id !== null) {
        generationId = chunk.id;
      }
      usage = usageFrom(chunk.usage) ?? usage;
      const choice = chunk.choices?.[0];
      if (choice === undefined) {
        continue;
      }
      if (choice.finish_reason !== undefined) {
        finishReason = choice.finish_reason;
      }
      const content = choice.delta?.content;
      if (content !== undefined && content !== null && content.length > 0) {
        yield { type: "token", text: content };
      }
      for (const deltaPart of toolCallDeltas(choice.delta?.tool_calls)) {
        yield { type: "tool_call_delta", delta: deltaPart };
      }
    }
  }

  yield { type: "finish", finishReason, generationId, usage };
}

export const LanguageModelLive = Layer.effect(
  LanguageModel,
  Effect.map(AppConfig, (config) => {
    const apiKey = optionalRedactedValue(config.openRouterApiKey);
    const requireApiKey = () => {
      if (apiKey === undefined) {
        throw new ModelProviderError("OpenRouter API key is not configured");
      }
      return apiKey;
    };

    return {
      hasApiKey: apiKey !== undefined,
      streamChat: (input) => {
        async function* run() {
          const key = requireApiKey();
          const response = await postChat(config.openRouterApiUrl, key, {
            model: input.model,
            messages: input.messages,
            tools: input.tools,
            temperature: input.temperature,
            stream: true,
            stream_options: { include_usage: true },
            usage: { include: true },
            provider: {
              allow_fallbacks: true,
              sort: "throughput",
            },
          });
          yield* parseOpenRouterStream(response);
        }
        return run();
      },
      complete: async (input) => {
        const key = requireApiKey();
        const response = await postChatWithRateLimitRetry(
          config.openRouterApiUrl,
          key,
          completionRequestBody(input),
        );
        const completion = decodeWireCompletion(await response.json());
        const first = completion.choices?.[0];
        return {
          text: first?.message?.content ?? "",
          finishReason: first?.finish_reason ?? null,
          generationId: completion.id ?? undefined,
          usage: usageFrom(completion.usage),
        };
      },
    } satisfies LanguageModelShape;
  }),
);
