import { apiFetch } from "./client"

interface QueryOptions {
  model?: string
  originSlug?: string
}

export async function queryKnowledgeBase(
  question: string,
  options?: QueryOptions,
): Promise<string> {
  const res = await apiFetch("/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, model: options?.model, origin_slug: options?.originSlug }),
  })
  if (!res.ok) {
    throw new Error(`Query failed: ${res.status} ${res.statusText}`)
  }
  const data: { answer: string } = await res.json()
  return data.answer
}

export interface StreamEvent {
  event: "source" | "token" | "done" | "error"
  data: Record<string, string>
}

interface StreamQueryOptions extends QueryOptions {
  signal?: AbortSignal
}

export async function* streamQuery(
  question: string,
  options?: StreamQueryOptions,
): AsyncGenerator<StreamEvent> {
  const res = await apiFetch("/query/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, model: options?.model, origin_slug: options?.originSlug }),
    signal: options?.signal,
  })
  if (!res.ok) {
    throw new Error(`Stream query failed: ${res.status} ${res.statusText}`)
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let eventType = ""
  let dataStr = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop()!

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7)
      } else if (line.startsWith("data: ")) {
        dataStr = line.slice(6)
      } else if (line === "") {
        if (eventType && dataStr) {
          yield {
            event: eventType as StreamEvent["event"],
            data: JSON.parse(dataStr),
          }
        }
        eventType = ""
        dataStr = ""
      }
    }
  }
}
