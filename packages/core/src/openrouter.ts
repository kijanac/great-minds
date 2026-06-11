import { Duration, Effect, Schedule } from "effect";
import { isTagged } from "effect/Predicate";
import {
  LlmBadResponse,
  LlmClient,
  LlmRateLimited,
  LlmRejected,
  LlmUnavailable,
  type LlmCompletionRequest,
  type LlmProviderError,
} from "./llm.js";

const OPENROUTER_REQUEST_TIMEOUT = "60 seconds";
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

        const upstream = yield* fetchChatCompletion(config, JSON.stringify(request));
        const text = yield* Effect.tryPromise({
          try: () => upstream.text(),
          catch: () => new LlmBadResponse({ message: "LLM provider returned an incompatible chat completion" }),
        });

        return yield* Effect.try({
          try: () => ({ content: JSON.parse(text).choices[0].message.content }),
          catch: () => new LlmBadResponse({ message: "LLM provider returned an incompatible chat completion" }),
        });
      }),
  });
}

function fetchChatCompletion(
  config: Extract<OpenRouterConfig, { kind: "openrouter" }>,
  body: string,
): Effect.Effect<Response, LlmProviderError> {
  return requestOnce(config, body).pipe(
    Effect.flatMap(classifyResponse),
    Effect.retry({
      while: isRetryableProviderError,
      schedule: retrySchedule,
    }),
  );
}

function requestOnce(
  config: Extract<OpenRouterConfig, { kind: "openrouter" }>,
  body: string,
): Effect.Effect<Response, LlmProviderError> {
  return Effect.tryPromise({
    try: (signal) =>
      fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: openRouterHeaders(config),
        body,
        signal,
      }),
    catch: () => new LlmUnavailable({ message: "LLM provider is unavailable" }),
  }).pipe(
    Effect.timeout(OPENROUTER_REQUEST_TIMEOUT),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new LlmUnavailable({ message: "LLM provider timed out" })),
    ),
  );
}

function classifyResponse(response: Response): Effect.Effect<Response, LlmRateLimited | LlmUnavailable | LlmRejected> {
  if (response.status === 429) {
    return Effect.fail(
      new LlmRateLimited({
        message: "LLM provider rate limited the request",
        retryAfterMs: retryAfterMs(response),
      }),
    );
  }

  if (isTransientStatus(response.status)) {
    return Effect.fail(new LlmUnavailable({ message: "LLM provider is unavailable" }));
  }

  if (!response.ok) {
    return Effect.fail(new LlmRejected({ message: "LLM provider rejected the request" }));
  }

  return Effect.succeed(response);
}

const retrySchedule = Schedule.recurs(OPENROUTER_RETRIES).pipe(
  Schedule.addDelay((attempt) => Effect.succeed(Duration.millis(backoffDelayMs(attempt + 1)))),
);

function backoffDelayMs(attempt: number): number {
  return (2 ** attempt + Math.random() * 0.5) * 1000;
}

function isRetryableProviderError(error: LlmProviderError): error is LlmRateLimited | LlmUnavailable {
  return isTagged("LlmRateLimited")(error) || isTagged("LlmUnavailable")(error);
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;

  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds)) return seconds * 1000;

  const dateMs = Date.parse(header) - Date.now();
  return Number.isFinite(dateMs) && dateMs > 0 ? dateMs : undefined;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function openRouterHeaders(config: Extract<OpenRouterConfig, { kind: "openrouter" }>): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  });

  if (config.siteUrl) headers.set("HTTP-Referer", config.siteUrl);
  if (config.appName) headers.set("X-Title", config.appName);

  return headers;
}
