import type { SourceRef } from "@/lib/types";

import { apiFetch } from "./client";

interface StreamQueryOptions {
  model?: string;
  originPath?: string;
  sessionContext?: string;
  mode: "query" | "btw";
  signal?: AbortSignal;
}

export interface StreamEvent {
  event: "source" | "token" | "done" | "error";
  data: Record<string, string>;
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

  const reader = res.body!.getReader();
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
          yield {
            event: eventType as StreamEvent["event"],
            data: JSON.parse(dataStr),
          };
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
      const label = event.data.path ?? event.data.query;
      const type = event.data.type;
      if (label && (type === "article" || type === "raw" || type === "search")) {
        sources.push({ label, type: type as SourceRef["type"], thinking: streamText || undefined });
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
