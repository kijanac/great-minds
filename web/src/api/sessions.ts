import { z } from "zod";

import { apiFetch, readJson } from "./client";
import { btwMessageSchema, thinkingBlockSchema, type BtwMessage, type ThinkingBlock } from "./schemas";

export interface ExchangePayload {
  query: string;
  thinking: ThinkingBlock[];
  answer: string;
  btws: { anchor: string; messages: BtwMessage[] }[];
}

export interface BtwPayload {
  anchor: string;
  paragraph: string;
  exchangeId: string;
  paragraphIndex: number;
  messages: BtwMessage[];
}

const pathResponseSchema = z.object({
  path: z.string(),
});

const sessionMetaEventSchema = z.object({
  type: z.literal("meta"),
  id: z.string(),
  query: z.string(),
  ts: z.string(),
  user_id: z.string().optional(),
  origin: z.string().optional(),
});

const sessionExchangeEventSchema = z.object({
  type: z.literal("exchange"),
  exId: z.string(),
  query: z.string(),
  thinking: z.array(thinkingBlockSchema),
  answer: z.string(),
  ts: z.string(),
});

const sessionBtwEventSchema = z.object({
  type: z.literal("btw"),
  exId: z.string(),
  anchor: z.string(),
  paragraph: z.string(),
  pi: z.number(),
  messages: z.array(btwMessageSchema),
  ts: z.string(),
});

const sessionEventSchema = z.discriminatedUnion("type", [
  sessionMetaEventSchema,
  sessionExchangeEventSchema,
  sessionBtwEventSchema,
]);

const sessionSummarySchema = z.object({
  id: z.string(),
  query: z.string(),
  created: z.string(),
  updated: z.string(),
  sources: z.array(z.string()),
});

const sessionResponseSchema = z.object({
  id: z.string(),
  events: z.array(sessionEventSchema),
});

export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export async function createSession(
  sessionId: string,
  exchange: ExchangePayload,
  origin?: string,
): Promise<string> {
  const res = await apiFetch(`/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, exchange, origin }),
  });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  const data = await readJson(res, pathResponseSchema);
  return data.path;
}

export async function appendExchange(
  sessionId: string,
  exchange: ExchangePayload,
): Promise<string> {
  const res = await apiFetch(`/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(exchange),
  });
  if (!res.ok) throw new Error(`Failed to append exchange: ${res.status}`);
  const data = await readJson(res, pathResponseSchema);
  return data.path;
}

export async function appendBtw(sessionId: string, btw: BtwPayload): Promise<string> {
  const res = await apiFetch(`/sessions/${sessionId}/btw`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(btw),
  });
  if (!res.ok) throw new Error(`Failed to append btw: ${res.status}`);
  const data = await readJson(res, pathResponseSchema);
  return data.path;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await apiFetch(`/sessions`);
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`);
  return readJson(res, z.array(sessionSummarySchema));
}

export async function loadSession(
  sessionId: string,
): Promise<{ id: string; events: SessionEvent[] }> {
  const res = await apiFetch(`/sessions/${sessionId}`);
  if (!res.ok) throw new Error(`Session not found: ${res.status}`);
  return readJson(res, sessionResponseSchema);
}
