import { z } from "zod";

import { apiFetch, vaultPath, readJson } from "./client";
import { paginatedSchema, thinkingBlockSchema, type ThinkingBlock } from "./schemas";

const btwExchangeSchema = z.object({
  query: z.string(),
  thinking: z.array(thinkingBlockSchema),
  answer: z.string(),
});

export type BtwExchange = z.infer<typeof btwExchangeSchema>;

export interface ExchangePayload {
  id: string;
  query: string;
  thinking: ThinkingBlock[];
  answer: string;
}

export interface BtwPayload {
  anchor: string;
  paragraph: string;
  exchangeId: string;
  paragraphIndex: number;
  exchanges: BtwExchange[];
}

const pathResponseSchema = z.object({
  path: z.string(),
});

const sessionOriginSchema = z.object({
  doc_path: z.string(),
  anchor: z.string().nullable().optional(),
  paragraph: z.string().nullable().optional(),
  paragraph_index: z.number().nullable().optional(),
});

export type SessionOrigin = z.infer<typeof sessionOriginSchema>;

const sessionMetaEventSchema = z.object({
  type: z.literal("meta"),
  id: z.string(),
  query: z.string(),
  ts: z.string(),
  user_id: z.string(),
  origin: sessionOriginSchema.nullish(),
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
  exchanges: z.array(btwExchangeSchema),
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
  user_id: z.string(),
  origin: sessionOriginSchema.nullish(),
});

const sessionListSchema = paginatedSchema(sessionSummarySchema);

export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionList = z.infer<typeof sessionListSchema>;

export async function createSession(
  sessionId: string,
  exchange: ExchangePayload,
  origin?: SessionOrigin,
): Promise<string> {
  const res = await apiFetch(vaultPath(`/sessions`), {
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
  const res = await apiFetch(vaultPath(`/sessions/${sessionId}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(exchange),
  });
  if (!res.ok) throw new Error(`Failed to append exchange: ${res.status}`);
  const data = await readJson(res, pathResponseSchema);
  return data.path;
}

export async function appendBtw(sessionId: string, btw: BtwPayload): Promise<string> {
  const res = await apiFetch(vaultPath(`/sessions/${sessionId}/btw`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(btw),
  });
  if (!res.ok) throw new Error(`Failed to append btw: ${res.status}`);
  const data = await readJson(res, pathResponseSchema);
  return data.path;
}

export async function listSessions(params?: {
  limit?: number;
  offset?: number;
}): Promise<SessionList> {
  const query = new URLSearchParams();
  if (params?.limit !== undefined) query.set("limit", String(params.limit));
  if (params?.offset !== undefined) query.set("offset", String(params.offset));

  const qs = query.toString();
  const res = await apiFetch(vaultPath(`/sessions${qs ? `?${qs}` : ""}`));
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`);
  return readJson(res, sessionListSchema);
}

const sessionResponseSchema = z.object({
  id: z.string(),
  events: z.array(sessionEventSchema),
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export async function loadSession(sessionId: string): Promise<SessionResponse> {
  const res = await apiFetch(vaultPath(`/sessions/${sessionId}`));
  if (!res.ok) throw new Error(`Session not found: ${res.status}`);
  return readJson(res, sessionResponseSchema);
}

const promoteResponseSchema = z.object({
  mode: z.enum(["ingested", "proposed"]),
  path: z.string(),
  title: z.string(),
  document_id: z.string().nullable().optional(),
  proposal_id: z.string().nullable().optional(),
});

export type PromoteResult = z.infer<typeof promoteResponseSchema>;

export async function promoteExchange(
  sessionId: string,
  exchangeId: string,
): Promise<PromoteResult> {
  const res = await apiFetch(vaultPath(`/sessions/${sessionId}/exchanges/${exchangeId}/promote`), {
    method: "POST",
  });
  if (!res.ok) {
    if (res.status === 400) throw new Error("Exchange has no answer yet");
    if (res.status === 404) throw new Error("Exchange not found");
    throw new Error(`Failed to promote: ${res.status}`);
  }
  return readJson(res, promoteResponseSchema);
}
