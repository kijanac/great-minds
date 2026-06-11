import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  RateLimitError,
} from "openai";
import { Effect } from "effect";
import {
  LlmBadResponse,
  LlmClient,
  LlmRateLimited,
  LlmRejected,
  LlmUnavailable,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmProviderError,
} from "@great-minds/core";

const OPENROUTER_REQUEST_TIMEOUT_MS = 60_000;
const OPENROUTER_RETRIES = 2;

export type OpenRouterConfig =
  | { kind: "disabled" }
  | {
      kind: "openrouter";
      apiKey: string;
      baseUrl: string;
      appName?: string;
      siteUrl?: string;
    };

export function openRouterLlmClient(config: OpenRouterConfig) {
  return LlmClient.of({
    complete: (request: LlmCompletionRequest) =>
      Effect.gen(function* () {
        if (config.kind === "disabled") {
          return yield* Effect.fail(new LlmUnavailable({ message: "LLM provider is not configured" }));
        }

        const client = openAiCompatibleClient(config);
        const completion = yield* Effect.tryPromise({
          try: () =>
            client.chat.completions.create({
              model: request.model,
              messages: request.messages,
            }),
          catch: providerError,
        });

        return yield* extractCompletion(completion);
      }),
  });
}

function openAiCompatibleClient(config: Extract<OpenRouterConfig, { kind: "openrouter" }>): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    timeout: OPENROUTER_REQUEST_TIMEOUT_MS,
    maxRetries: OPENROUTER_RETRIES,
    defaultHeaders: openRouterAttributionHeaders(config),
  });
}

function extractCompletion(completion: OpenAI.Chat.Completions.ChatCompletion): Effect.Effect<LlmCompletion, LlmBadResponse> {
  const content = completion.choices[0]?.message.content;
  return typeof content === "string"
    ? Effect.succeed({ content })
    : Effect.fail(new LlmBadResponse({ message: "LLM provider returned an incompatible chat completion" }));
}

function providerError(error: unknown): LlmProviderError {
  if (error instanceof RateLimitError) {
    return new LlmRateLimited({
      message: "LLM provider rate limited the request",
      retryAfterMs: retryAfterMs(error.headers),
    });
  }

  if (error instanceof APIConnectionTimeoutError) {
    return new LlmUnavailable({ message: "LLM provider timed out" });
  }

  if (error instanceof APIConnectionError) {
    return new LlmUnavailable({ message: "LLM provider is unavailable" });
  }

  if (error instanceof APIError) {
    return isTransientStatus(error.status)
      ? new LlmUnavailable({ message: "LLM provider is unavailable" })
      : new LlmRejected({ message: "LLM provider rejected the request" });
  }

  return new LlmUnavailable({ message: "LLM provider is unavailable" });
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const header = headers?.get("retry-after");
  if (!header) return undefined;

  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds)) return seconds * 1000;

  const dateMs = Date.parse(header) - Date.now();
  return Number.isFinite(dateMs) && dateMs > 0 ? dateMs : undefined;
}

function isTransientStatus(status: number | undefined): boolean {
  return status === 408 || status === 500 || status === 502 || status === 503 || status === 504;
}

function openRouterAttributionHeaders(config: Extract<OpenRouterConfig, { kind: "openrouter" }>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.siteUrl) headers["HTTP-Referer"] = config.siteUrl;
  if (config.appName) headers["X-Title"] = config.appName;
  return headers;
}

export function openRouterHeaders(config: Extract<OpenRouterConfig, { kind: "openrouter" }>): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  });

  for (const [name, value] of Object.entries(openRouterAttributionHeaders(config))) {
    headers.set(name, value);
  }

  return headers;
}
