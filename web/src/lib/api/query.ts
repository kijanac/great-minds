import { z } from "zod";

import type { HistoryMessage, SourceRef } from "$lib/types";

import { apiFetch, vaultPath } from "./client";

interface StreamQueryOptions {
  model?: string;
  originPath?: string;
  history?: HistoryMessage[];
  mode: "query" | "btw";
  signal?: AbortSignal;
}

const sourceEventDataSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("article"),
    path: z.string(),
    title: z.string().nullable().optional(),
    start: z.number().optional(),
    end: z.number().optional(),
  }),
  z.object({
    type: z.literal("raw"),
    path: z.string(),
    title: z.string().nullable().optional(),
    start: z.number().optional(),
    end: z.number().optional(),
  }),
  z.object({
    type: z.literal("search"),
    query: z.string(),
    scope: z.enum(["kb", "web"]).optional(),
    path: z.string().optional(),
    title: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal("query"), filters: z.record(z.string(), z.unknown()).optional() }),
  z.object({
    type: z.literal("links"),
    path: z.string(),
    title: z.string().nullable().optional(),
  }),
]);

const tokenEventSchema = z.object({
  event: z.literal("token"),
  data: z.object({ text: z.string() }),
});

const errorEventSchema = z.object({
  event: z.literal("error"),
  data: z.object({ message: z.string() }),
});

const sourcePendingEventSchema = z.object({
  event: z.literal("source_pending"),
  data: z.object({
    call_id: z.string(),
    source: sourceEventDataSchema,
  }),
});

const sourceSettledEventSchema = z.object({
  event: z.literal("source_settled"),
  data: z.object({ call_id: z.string() }),
});

export type StreamEvent =
  | { event: "source"; data: z.infer<typeof sourceEventDataSchema> }
  | z.infer<typeof sourcePendingEventSchema>
  | z.infer<typeof sourceSettledEventSchema>
  | z.infer<typeof tokenEventSchema>
  | z.infer<typeof errorEventSchema>
  | { event: "done"; data: Record<string, never> };

function parseStreamEvent(eventType: string, dataStr: string): StreamEvent | null {
  const data: unknown = JSON.parse(dataStr);

  if (eventType === "source") {
    return { event: "source", data: sourceEventDataSchema.parse(data) };
  }
  if (eventType === "source_pending") {
    return sourcePendingEventSchema.parse({ event: "source_pending", data });
  }
  if (eventType === "source_settled") {
    return sourceSettledEventSchema.parse({ event: "source_settled", data });
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

  return null;
}

export async function* streamQuery(
  question: string,
  options?: StreamQueryOptions,
): AsyncGenerator<StreamEvent> {
  const res = await apiFetch(vaultPath("/query"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      model: options?.model,
      origin_path: options?.originPath,
      history: options?.history,
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
          const event = parseStreamEvent(eventType, dataStr);
          if (event !== null) {
            yield event;
          }
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
  const pendingCallIndexes = new Map<string, number | null>();
  let streamText = "";
  let clearOnNextToken = false;
  let replacementSlot: number | undefined;

  const notifySources = () => callbacks?.onSources?.([...sources]);

  const removeSource = (index: number) => {
    sources.splice(index, 1);
    for (const [callId, pendingIndex] of pendingCallIndexes) {
      if (pendingIndex !== null && pendingIndex > index) {
        pendingCallIndexes.set(callId, pendingIndex - 1);
      }
    }
    notifySources();
  };

  const sourceRef = (data: z.infer<typeof sourceEventDataSchema>, pending = false): SourceRef => {
    if (data.type === "article" || data.type === "raw") {
      const isExpand = data.start !== undefined && data.end !== undefined;
      return {
        label: data.path,
        type: data.type,
        title: data.title ?? null,
        thinking: streamText || undefined,
        ranges: isExpand ? [{ start: data.start!, end: data.end! }] : [],
        full: !isExpand,
        pending: pending || undefined,
      };
    }
    if (data.type === "search") {
      return {
        label: data.query,
        type: "search",
        scope: data.scope,
        path: data.path,
        title: data.title ?? null,
        thinking: streamText || undefined,
        pending: pending || undefined,
      };
    }
    if (data.type === "links") {
      return {
        label: data.path,
        type: "links",
        title: data.title ?? null,
        thinking: streamText || undefined,
        pending: pending || undefined,
      };
    }
    const filters = data.filters ?? {};
    const summary =
      Object.entries(filters)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(", ") || "filtered sources";
    return {
      label: summary,
      type: "query",
      thinking: streamText || undefined,
      pending: pending || undefined,
    };
  };

  const addResolvedSource = (
    data: z.infer<typeof sourceEventDataSchema>,
    pendingIndex?: number,
  ) => {
    if (data.type === "article" || data.type === "raw") {
      if (pendingIndex !== undefined) {
        removeSource(pendingIndex);
      }
      // Aggregate per document: read+expand of the same path collapse to one
      // card, accumulating which chunk ranges entered and whether it was a
      // full read. (no start/end → full read; with → an expanded range.)
      const path = data.path;
      const isExpand = data.start !== undefined && data.end !== undefined;
      const range = isExpand ? { start: data.start!, end: data.end! } : null;
      const index = sources.findIndex(
        (source) => source.label === path && (source.type === "article" || source.type === "raw"),
      );
      if (index >= 0) {
        const previous = sources[index];
        sources[index] = {
          ...previous,
          ranges: range ? [...(previous.ranges ?? []), range] : previous.ranges,
          full: previous.full || !isExpand,
        };
      } else {
        sources.push(sourceRef(data));
      }
      notifySources();
      clearOnNextToken = true;
      return;
    }

    if (data.type === "links") {
      const existingIndex = sources.findIndex(
        (source, index) =>
          index !== pendingIndex && source.type === "links" && source.label === data.path,
      );
      if (existingIndex >= 0) {
        if (pendingIndex !== undefined) {
          removeSource(pendingIndex);
        }
        return;
      }
    }

    const resolved = sourceRef(data);
    if (pendingIndex === undefined) {
      sources.push(resolved);
    } else {
      sources.splice(pendingIndex, 1, resolved);
    }
    notifySources();
    clearOnNextToken = true;
  };

  for await (const event of stream) {
    if (replacementSlot !== undefined && event.event !== "source") {
      const pendingIndex = replacementSlot;
      replacementSlot = undefined;
      removeSource(pendingIndex);
    }

    if (event.event === "token") {
      if (clearOnNextToken) {
        streamText = "";
        clearOnNextToken = false;
      }
      streamText += event.data.text;
      callbacks?.onToken?.(streamText);
    } else if (event.event === "source_pending") {
      const data = event.data.source;
      if (
        (data.type === "article" || data.type === "raw") &&
        sources.some(
          (source) =>
            source.label === data.path && (source.type === "article" || source.type === "raw"),
        )
      ) {
        pendingCallIndexes.set(event.data.call_id, null);
        continue;
      }
      pendingCallIndexes.set(event.data.call_id, sources.length);
      sources.push(sourceRef(data, true));
      notifySources();
      clearOnNextToken = true;
    } else if (event.event === "source_settled") {
      const pendingIndex = pendingCallIndexes.get(event.data.call_id);
      pendingCallIndexes.delete(event.data.call_id);
      if (pendingIndex !== undefined && pendingIndex !== null) {
        replacementSlot = pendingIndex;
      }
    } else if (event.event === "source") {
      const pendingIndex = replacementSlot;
      replacementSlot = undefined;
      addResolvedSource(event.data, pendingIndex);
    } else if (event.event === "done") {
      break;
    } else if (event.event === "error") {
      console.error("Stream error:", event.data.message);
      break;
    }
  }

  const settledSources = sources.filter((source) => source.pending !== true);
  if (settledSources.length !== sources.length) {
    sources.splice(0, sources.length, ...settledSources);
    notifySources();
  }

  return { answer: streamText, sources };
}
