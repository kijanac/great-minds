const API_BASE = "/api"

export interface ExchangePayload {
  query: string
  thinking: { sources: { label: string; type: string }[] }[]
  answer: string
  btws: { anchor: string; messages: { role: string; text: string }[] }[]
}

export interface BtwPayload {
  anchor: string
  exchangeId: string
  paragraphIndex: number
  messages: { role: string; text: string }[]
}

export async function createSession(
  sessionId: string,
  exchange: ExchangePayload,
): Promise<string> {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, exchange }),
  })
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`)
  const data: { path: string } = await res.json()
  return data.path
}

export async function appendExchange(
  sessionId: string,
  exchange: ExchangePayload,
): Promise<string> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(exchange),
  })
  if (!res.ok) throw new Error(`Failed to append exchange: ${res.status}`)
  const data: { path: string } = await res.json()
  return data.path
}

export async function appendBtw(
  sessionId: string,
  btw: BtwPayload,
): Promise<string> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/btw`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(btw),
  })
  if (!res.ok) throw new Error(`Failed to append btw: ${res.status}`)
  const data: { path: string } = await res.json()
  return data.path
}

export interface SessionSummary {
  id: string
  query: string
  created: string
  updated: string
  sources: string[]
}

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await fetch(`${API_BASE}/sessions`)
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`)
  return res.json()
}

export interface SessionEvent {
  type: "meta" | "exchange" | "btw"
  [key: string]: unknown
}

export async function loadSession(
  sessionId: string,
): Promise<{ id: string; events: SessionEvent[] }> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}`)
  if (!res.ok) throw new Error(`Session not found: ${res.status}`)
  return res.json()
}
