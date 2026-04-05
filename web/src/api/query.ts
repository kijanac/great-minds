const API_BASE = "/api"

export async function queryKnowledgeBase(
  question: string,
  model?: string,
): Promise<string> {
  const res = await fetch(`${API_BASE}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, model }),
  })
  if (!res.ok) {
    throw new Error(`Query failed: ${res.status} ${res.statusText}`)
  }
  const data: { answer: string } = await res.json()
  return data.answer
}

export interface StreamEvent {
  event: "source" | "token" | "round" | "done" | "error"
  data: Record<string, string>
}

export async function* streamQuery(
  question: string,
  model?: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${API_BASE}/query/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, model }),
    signal,
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
