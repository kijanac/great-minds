import { Context, Effect, Layer, Option, Redacted } from "effect";

import { AppConfig } from "./config.ts";

export type LlmTextMessage = {
  readonly role: "system" | "user" | "assistant";
  readonly content: string | null;
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
  readonly responseFormat?: "json_object";
};

export type ModelCompletion = {
  readonly text: string;
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

const usageFrom = (value: unknown): LlmUsage | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const promptTokens = numberField(record.prompt_tokens);
  const completionTokens = numberField(record.completion_tokens);
  const totalTokens = numberField(record.total_tokens);
  const cost = numberField(record.cost);
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

const numberField = (value: unknown) => (typeof value === "number" ? value : undefined);

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

const parseDataLines = (block: string) =>
  block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");

const toolCallDeltas = (choice: Record<string, unknown>): readonly LlmToolCallDelta[] => {
  const delta = choice.delta;
  if (typeof delta !== "object" || delta === null) {
    return [];
  }
  const raw = (delta as Record<string, unknown>).tool_calls;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item) => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const fn = record.function;
    const functionRecord =
      typeof fn === "object" && fn !== null ? (fn as Record<string, unknown>) : {};
    const index = typeof record.index === "number" ? record.index : 0;
    return [
      {
        index,
        id: typeof record.id === "string" ? record.id : undefined,
        name: typeof functionRecord.name === "string" ? functionRecord.name : undefined,
        argumentsDelta:
          typeof functionRecord.arguments === "string" ? functionRecord.arguments : undefined,
      },
    ];
  });
};

async function* parseOpenRouterStream(response: Response): AsyncIterable<ModelStreamPart> {
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
      const splitAt = buffer.indexOf("\n\n");
      if (splitAt === -1) {
        break;
      }
      const block = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      const data = parseDataLines(block);
      if (data.length === 0 || data === "[DONE]") {
        continue;
      }
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (typeof parsed.id === "string") {
        generationId = parsed.id;
      }
      usage = usageFrom(parsed.usage) ?? usage;
      const choices = parsed.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        continue;
      }
      const choice = choices[0] as Record<string, unknown>;
      if (typeof choice.finish_reason === "string" || choice.finish_reason === null) {
        finishReason = choice.finish_reason as string | null;
      }
      const delta = choice.delta;
      if (typeof delta === "object" && delta !== null) {
        const content = (delta as Record<string, unknown>).content;
        if (typeof content === "string" && content.length > 0) {
          yield { type: "token", text: content };
        }
      }
      for (const deltaPart of toolCallDeltas(choice)) {
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
        const response = await postChatWithRateLimitRetry(config.openRouterApiUrl, key, {
          model: input.model,
          messages: input.messages,
          temperature: input.temperature,
          response_format:
            input.responseFormat === undefined ? undefined : { type: input.responseFormat },
          stream: false,
          usage: { include: true },
          provider: {
            allow_fallbacks: true,
            sort: "throughput",
          },
        });
        const json = (await response.json()) as Record<string, unknown>;
        const choices = json.choices;
        const first =
          Array.isArray(choices) && choices.length > 0
            ? (choices[0] as Record<string, unknown>)
            : undefined;
        const message =
          typeof first?.message === "object" && first.message !== null
            ? (first.message as Record<string, unknown>)
            : undefined;
        const text = typeof message?.content === "string" ? message.content : "";
        return {
          text,
          generationId: typeof json.id === "string" ? json.id : undefined,
          usage: usageFrom(json.usage),
        };
      },
    } satisfies LanguageModelShape;
  }),
);
