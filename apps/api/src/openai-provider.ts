import type { OpenAIChatCompletionRequest, OpenAIErrorResponse } from "@great-minds/protocol-openai/chat";
import { HTTPException } from "hono/http-exception";
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

export async function completeChat(
  config: OpenAiProviderConfig,
  request: OpenAIChatCompletionRequest,
): Promise<{ answer: string }> {
  if (config.kind === "disabled") throw new HTTPException(503, { message: "LLM provider is not configured" });

  let upstream: Response;
  try {
    upstream = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: providerHeaders(config),
      body: JSON.stringify(request),
    });
  } catch {
    throw new HTTPException(502, { message: "LLM provider is unavailable" });
  }

  if (!upstream.ok) throw new HTTPException(502, { message: "LLM provider rejected the request" });

  try {
    const body = JSON.parse(await upstream.text());
    return { answer: body.choices[0].message.content };
  } catch {
    throw new HTTPException(502, { message: "LLM provider returned an incompatible chat completion" });
  }
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

