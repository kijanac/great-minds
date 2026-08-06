import { z } from "zod";

import type { BtwPayload, OriginScope, SessionOrigin } from "./sessions";
import { apiFetch, readJson, vaultPath } from "./client";
import { sourceRefSchema } from "./schemas";
import type { HistoryMessage } from "$lib/types";

interface ReplyQueryPayload {
  question: string;
  model?: string;
  origin_path?: string;
  origin_scope?: OriginScope;
  history: HistoryMessage[];
  mode: "query" | "btw";
}

export type CreateReplyPayload =
  | (ReplyQueryPayload & {
      kind: "exchange";
      exchange_id: string;
      session_id: string;
    })
  | (ReplyQueryPayload & {
      kind: "exchange";
      exchange_id: string;
      create: {
        idempotency_key: string;
        origin_scope?: OriginScope;
        origin?: SessionOrigin;
      };
    })
  | (ReplyQueryPayload & {
      kind: "btw";
      session_id: string;
      btw: BtwPayload;
    })
  | (ReplyQueryPayload & {
      kind: "ephemeral";
    });

const createReplyResponseSchema = z.object({
  reply_id: z.string(),
  session_id: z.string().nullable(),
});

export type CreateReplyResponse = z.infer<typeof createReplyResponseSchema>;

export const replySnapshotSchema = z.object({
  reply_id: z.string(),
  session_id: z.string().nullable(),
  kind: z.enum(["exchange", "btw", "ephemeral"]),
  status: z.enum(["running", "completed", "failed"]),
  answer: z.string(),
  sources: z.array(sourceRefSchema),
  error: z.string().nullable(),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ReplySnapshot = z.infer<typeof replySnapshotSchema>;

export class ReplyStreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ReplyStreamError";
  }
}

type SseMessage = {
  event: string;
  data: string;
};

function parseSseBlock(block: string): SseMessage | null {
  let event = "";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trimStart();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  // SSE omits the event line for the default "message" event.
  if (event.length === 0) {
    return data.length === 0 ? null : { event: "message", data: data.join("\n") };
  }
  return { event, data: data.join("\n") };
}

function retryDelay(attempt: number) {
  return Math.min(1000 * 2 ** attempt, 10_000);
}

function sleep(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export async function createReply(
  payload: CreateReplyPayload,
  signal?: AbortSignal,
): Promise<CreateReplyResponse> {
  const response = await apiFetch(vaultPath("/replies"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    throw new ReplyStreamError(await response.text(), response.status);
  }
  return readJson(response, createReplyResponseSchema);
}

export async function* streamReply(
  replyId: string,
  signal?: AbortSignal,
): AsyncGenerator<ReplySnapshot> {
  let attempt = 0;
  let previousVersion = -1;

  while (!signal?.aborted) {
    try {
      const response = await apiFetch(vaultPath(`/replies/${replyId}/stream`), {
        headers: { Accept: "text/event-stream" },
        signal,
      });
      if (!response.ok) {
        throw new ReplyStreamError(await response.text(), response.status);
      }
      if (!response.body) {
        throw new ReplyStreamError("Reply stream unavailable", response.status);
      }

      attempt = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!signal?.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const message = parseSseBlock(block);
          if (message?.event === "message" && message.data.length > 0) {
            const snapshot = replySnapshotSchema.parse(JSON.parse(message.data));
            if (snapshot.version !== previousVersion) {
              previousVersion = snapshot.version;
              yield snapshot;
            }
            if (snapshot.status !== "running") {
              return;
            }
          } else if (message?.event === "done") {
            return;
          }
          separator = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ReplyStreamError) throw error;
      console.warn("Reply stream disconnected; retrying", error);
    }

    if (!signal?.aborted) {
      await sleep(retryDelay(attempt), signal);
      attempt += 1;
    }
  }
}
