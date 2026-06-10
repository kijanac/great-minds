import { Effect, type Context } from "effect";
import { LlmProviderError, type LlmClient } from "@great-minds/core/llm";
import type { OpenAIChatCompletionRequest, OpenAIErrorResponse } from "@great-minds/protocol-openai/chat";
import type { OpenAiProviderConfig } from "./context.js";

export async function modelListResponse(config: OpenAiProviderConfig, requestId: string): Promise<Response> {
  if (config.kind === "disabled") {
    return openAiError("LLM provider is not configured", "configuration_error", 503, requestId);
  }

  try {
    const upstream = await fetch(`${config.baseUrl}/models`, {
      headers: providerHeaders(config),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: proxyHeaders(upstream.headers, requestId),
    });
  } catch {
    return openAiError("LLM provider is unavailable", "provider_error", 502, requestId);
  }
}

export async function chatCompletionResponse(
  config: OpenAiProviderConfig,
  request: OpenAIChatCompletionRequest,
  requestId: string,
): Promise<Response> {
  if (config.kind === "disabled") {
    return openAiError("LLM provider is not configured", "provider_error", 503, requestId);
  }

  try {
    const upstream = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: providerHeaders(config),
      body: JSON.stringify(request),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: proxyHeaders(upstream.headers, requestId),
    });
  } catch {
    return openAiError("LLM provider is unavailable", "provider_error", 502, requestId);
  }
}

export function openRouterLlmClient(config: OpenAiProviderConfig): Context.Tag.Service<LlmClient> {
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
              headers: providerHeaders(config),
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

function providerHeaders(config: Extract<OpenAiProviderConfig, { kind: "openrouter" }>) {
  const headers = new Headers({
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  });

  if (config.siteUrl) headers.set("HTTP-Referer", config.siteUrl);
  if (config.appName) headers.set("X-Title", config.appName);

  return headers;
}

function proxyHeaders(upstreamHeaders: Headers, requestId: string): Headers {
  const headers = new Headers();
  const contentType = upstreamHeaders.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("x-request-id", requestId);
  return headers;
}

function openAiError(message: string, type: string, status: number, requestId: string): Response {
  const error: OpenAIErrorResponse = {
    error: { message, type, code: type },
  };

  return Response.json(error, {
    status,
    headers: { "x-request-id": requestId },
  });
}

