import { z } from "zod";

import type { SourceRef } from "@/lib/types";

import { apiFetch } from "./client";

interface StreamQueryOptions {
  model?: string;
  originPath?: string;
  sessionContext?: string;
  mode: "query" | "btw";
  signal?: AbortSignal;
}

const sourceEventDataSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("article"), path: z.string() }),
  z.object({ type: z.literal("raw"), path: z.string() }),
  z.object({ type: z.literal("search"), query: z.string() }),
  z.object({ type: z.literal("query"), filters: z.record(z.unknown()).optional() }),
]);

const tokenEventSchema = z.object({
  event: z.literal("token"),
  data: z.object({ text: z.string() }),
});

const errorEventSchema = z.object({
  event: z.literal("error"),
  data: z.object({ message: z.string() }),
});

export type StreamEvent =
  | { event: "source"; data: z.infer<typeof sourceEventDataSchema> }
  | z.infer<typeof tokenEventSchema>
  | z.infer<typeof errorEventSchema>
  | { event: "done"; data: Record<string, never> };

function parseStreamEvent(eventType: string, dataStr: string): StreamEvent {
  const data: unknown = JSON.parse(dataStr);

  if (eventType === "source") {
    return { event: "source", data: sourceEventDataSchema.parse(data) };
  }
  if (eventType === "token") {
    return tokenEventSchema.parse({ event: "token", data });
  }
  if (eventType === "done") {
    return { event: "done", data: {} };
  }
  if (eventType === "error") {
    return errorEventSchema.parse({ event: "error", data });
  }

  throw new Error(`Unknown stream event type: ${eventType}`);
}

export async function* streamQuery(
  question: string,
  options?: StreamQueryOptions,
): AsyncGenerator<StreamEvent> {
  const res = await apiFetch("/query/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      model: options?.model,
      origin_path: options?.originPath,
      session_context: options?.sessionContext,
      mode: options?.mode,
    }),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(`Stream query failed: ${res.status} ${res.statusText}`);
  }

  if (!res.body) {
    throw new Error("Stream query response missing body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";
  let dataStr = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7);
      } else if (line.startsWith("data: ")) {
        dataStr = line.slice(6);
      } else if (line === "") {
        if (eventType && dataStr) {
          yield parseStreamEvent(eventType, dataStr);
        }
        eventType = "";
        dataStr = "";
      }
    }
  }
}

/**
 * Consume a stream of query events, accumulating sources and answer text.
 * Handles the clearOnNextToken pattern (stream text between sources is
 * captured as per-source "thinking" then reset for the next segment).
 */
export async function consumeStream(
  stream: AsyncGenerator<StreamEvent>,
  callbacks?: {
    onSources?: (sources: SourceRef[]) => void;
    onToken?: (text: string) => void;
  },
): Promise<{ answer: string; sources: SourceRef[] }> {
  const sources: SourceRef[] = [];
  let streamText = "";
  let clearOnNextToken = false;

  for await (const event of stream) {
    if (event.event === "token") {
      if (clearOnNextToken) {
        streamText = "";
        clearOnNextToken = false;
      }
      streamText += event.data.text;
      callbacks?.onToken?.(streamText);
    } else if (event.event === "source") {
      if (event.data.type === "article" || event.data.type === "raw") {
        sources.push({
          label: event.data.path,
          type: event.data.type,
          thinking: streamText || undefined,
        });
        callbacks?.onSources?.([...sources]);
        clearOnNextToken = true;
      } else if (event.data.type === "search") {
        sources.push({
          label: event.data.query,
          type: "search",
          thinking: streamText || undefined,
        });
        callbacks?.onSources?.([...sources]);
        clearOnNextToken = true;
      }
    } else if (event.event === "done") {
      break;
    } else if (event.event === "error") {
      console.error("Stream error:", event.data.message);
      break;
    }
  }

  return { answer: streamText, sources };
}
