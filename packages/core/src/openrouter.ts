import { Effect, type Context } from "effect";
import { LlmClient, LlmProviderError } from "./llm.js";

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

        const upstream = yield* Effect.tryPromise({
          try: () =>
            fetch(`${config.baseUrl}/chat/completions`, {
              method: "POST",
              headers: openRouterHeaders(config),
              body: JSON.stringify(request),
            }),
          catch: () => new LlmProviderError({ message: "LLM provider is unavailable" }),
        });

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

export function openRouterHeaders(config: Extract<OpenRouterConfig, { kind: "openrouter" }>): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  });

  if (config.siteUrl) headers.set("HTTP-Referer", config.siteUrl);
  if (config.appName) headers.set("X-Title", config.appName);

  return headers;
}
