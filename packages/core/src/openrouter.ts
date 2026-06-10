import { Effect, type Context } from "effect";
import { LlmClient, LlmProviderError } from "./llm.js";

const OPENROUTER_REQUEST_TIMEOUT = "60 seconds";
const RATE_LIMIT_RETRIES = 6;
const GENERIC_RETRIES = 2;
const MAX_BACKOFF_SECONDS = 60;

export type OpenRouterConfig =
  | { kind: "disabled" }
  | {
      kind: "openrouter";
      apiKey: string;
      baseUrl: string;
      appName?: string;
      siteUrl?: string;
    };

export function openRouterLlmClient(config: OpenRouterConfig): Context.Tag.Service<LlmClient> {
  return {
    complete: (request) =>
      Effect.gen(function* () {
        if (config.kind === "disabled") {
          return yield* Effect.fail(new LlmProviderError({ message: "LLM provider is not configured" }));
        }

        const upstream = yield* fetchChatCompletion(config, JSON.stringify(request));

        if (!upstream.ok) {
          return yield* Effect.fail(new LlmProviderError({ message: "LLM provider rejected the request" }));
        }

        const text = yield* Effect.tryPromise({
          try: () => upstream.text(),
          catch: () => new LlmProviderError({ message: "LLM provider returned an incompatible chat completion" }),
        });

        return yield* Effect.try({
          try: () => ({ content: JSON.parse(text).choices[0].message.content }),
          catch: () => new LlmProviderError({ message: "LLM provider returned an incompatible chat completion" }),
        });
      }),
  };
}

function fetchChatCompletion(
  config: Extract<OpenRouterConfig, { kind: "openrouter" }>,
  body: string,
): Effect.Effect<Response, LlmProviderError> {
  const attempt = (rateLimitAttempts: number, genericAttempts: number): Effect.Effect<Response, LlmProviderError> =>
    requestOnce(config, body).pipe(
      Effect.flatMap((response) => {
        if (response.status === 429) {
          if (rateLimitAttempts >= RATE_LIMIT_RETRIES) {
            return Effect.fail(new LlmProviderError({ message: "LLM provider rate limit exhausted" }));
          }

          return sleepBeforeRetry(rateLimitDelayMs(response, rateLimitAttempts + 1)).pipe(
            Effect.flatMap(() => attempt(rateLimitAttempts + 1, genericAttempts)),
          );
        }

        if (isTransientStatus(response.status) && genericAttempts < GENERIC_RETRIES) {
          return sleepBeforeRetry(genericDelayMs(genericAttempts + 1)).pipe(
            Effect.flatMap(() => attempt(rateLimitAttempts, genericAttempts + 1)),
          );
        }

        return Effect.succeed(response);
      }),
      Effect.catchAll((error) => {
        if (genericAttempts >= GENERIC_RETRIES) return Effect.fail(error);

        return sleepBeforeRetry(genericDelayMs(genericAttempts + 1)).pipe(
          Effect.flatMap(() => attempt(rateLimitAttempts, genericAttempts + 1)),
        );
      }),
    );

  return attempt(0, 0);
}

function requestOnce(
  config: Extract<OpenRouterConfig, { kind: "openrouter" }>,
  body: string,
): Effect.Effect<Response, LlmProviderError> {
  return Effect.tryPromise({
    try: () =>
      fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: openRouterHeaders(config),
        body,
      }),
    catch: () => new LlmProviderError({ message: "LLM provider is unavailable" }),
  }).pipe(
    Effect.timeoutFail({
      duration: OPENROUTER_REQUEST_TIMEOUT,
      onTimeout: () => new LlmProviderError({ message: "LLM provider timed out" }),
    }),
  );
}

function sleepBeforeRetry(ms: number): Effect.Effect<void> {
  return Effect.sleep(`${ms} millis`);
}

function rateLimitDelayMs(response: Response, attempt: number): number {
  const retryAfter = retryAfterMs(response);
  if (retryAfter !== null) return retryAfter;

  return (Math.min(MAX_BACKOFF_SECONDS, 2 ** attempt) + Math.random()) * 1000;
}

function genericDelayMs(attempt: number): number {
  return (2 ** attempt + Math.random() * 0.5) * 1000;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;

  const seconds = Number.parseFloat(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status >= 500;
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
