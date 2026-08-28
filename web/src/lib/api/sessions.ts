import { z } from "zod";

import { apiFetch, vaultPath, readJson } from "./client";
import { paginatedSchema, thinkingBlockSchema } from "./schemas";

const btwExchangeSchema = z.object({
  query: z.string(),
  thinking: z.array(thinkingBlockSchema),
  answer: z.string(),
});

export type BtwExchange = z.infer<typeof btwExchangeSchema>;

export interface BtwPayload {
  quote: string;
  blockOffset: number;
  context: string;
  exchangeId: string;
  exchanges: BtwExchange[];
}

const sessionOriginSchema = z.object({
  doc_path: z.string(),
  origin_scope: z.enum(["vault", "personal"]).default("vault"),
  anchor: z.string().nullable(),
  paragraph: z.string().nullable(),
  paragraph_index: z.number().nullable(),
});

export type SessionOrigin = z.infer<typeof sessionOriginSchema>;
export type OriginScope = SessionOrigin["origin_scope"];

const sessionMetaEventSchema = z.object({
  type: z.literal("meta"),
  id: z.string(),
  query: z.string(),
  ts: z.string(),
  user_id: z.string(),
  origin: sessionOriginSchema.nullable(),
});

const sessionExchangeEventSchema = z.object({
  type: z.literal("exchange"),
  exId: z.string(),
  reply_id: z.string().optional(),
  query: z.string(),
  thinking: z.array(thinkingBlockSchema),
  answer: z.string(),
  ts: z.string(),
});

const sessionBtwEventSchema = z.object({
  type: z.literal("btw"),
  exId: z.string(),
  reply_id: z.string().optional(),
  quote: z.string(),
  blockOffset: z.number(),
  context: z.string(),
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
  created_at: z.string(),
  updated_at: z.string(),
  user_id: z.string(),
  origin: sessionOriginSchema.nullable(),
  // Resolved at read time from the origin document's current title; null
  // when unresolvable (fall back to the file stem).
  origin_title: z.string().nullable(),
});

const sessionListSchema = paginatedSchema(sessionSummarySchema);

export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionList = z.infer<typeof sessionListSchema>;

const originSessionDetailSchema = z.object({
  session: sessionSummarySchema,
  events: z.array(sessionEventSchema),
});

export type OriginSessionDetail = z.infer<typeof originSessionDetailSchema>;

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

/** Sessions anchored to (or initiated from) a document, created_at asc. */
export async function listSessionsByOrigin(
  docPath: string,
  signal?: AbortSignal,
): Promise<OriginSessionDetail[]> {
  const qs = new URLSearchParams({ doc_path: docPath });
  const res = await apiFetch(vaultPath(`/sessions/by-origin?${qs.toString()}`), { signal });
  if (!res.ok) throw new Error(`Failed to load doc sessions: ${res.status}`);
  return readJson(res, z.array(originSessionDetailSchema));
}

const sessionResponseSchema = z.object({
  id: z.string(),
  events: z.array(sessionEventSchema),
  origin_title: z.string().nullable(),
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export async function loadSession(sessionId: string): Promise<SessionResponse> {
  const res = await apiFetch(vaultPath(`/sessions/${sessionId}`));
  if (!res.ok) throw new Error(`Session not found: ${res.status}`);
  return readJson(res, sessionResponseSchema);
}

export async function loadSessionMarkdown(sessionId: string): Promise<string> {
  const res = await apiFetch(vaultPath(`/sessions/${sessionId}/markdown`));
  if (!res.ok) throw new Error(`Session markdown not found: ${res.status}`);
  return res.text();
}

const promoteResponseSchema = z.object({
  mode: z.enum(["ingested", "proposed"]),
  path: z.string(),
  title: z.string().nullable(),
  document_id: z.string().nullable(),
  proposal_id: z.string().nullable(),
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
