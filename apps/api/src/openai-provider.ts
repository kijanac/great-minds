import { openRouterHeaders, type OpenRouterConfig } from "./openrouter.js";
import type { OpenAIChatCompletionRequest, OpenAIErrorResponse } from "@great-minds/protocol-openai/chat";

export async function modelListResponse(config: OpenRouterConfig, requestId: string): Promise<Response> {
  if (config.kind === "disabled") {
    return openAiError("LLM provider is not configured", "configuration_error", 503, requestId);
  }

  try {
    const upstream = await fetch(`${config.baseUrl}/models`, {
      headers: openRouterHeaders(config),
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
  config: OpenRouterConfig,
  request: OpenAIChatCompletionRequest,
  requestId: string,
): Promise<Response> {
  if (config.kind === "disabled") {
    return openAiError("LLM provider is not configured", "provider_error", 503, requestId);
  }

  try {
    const upstream = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: openRouterHeaders(config),
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
