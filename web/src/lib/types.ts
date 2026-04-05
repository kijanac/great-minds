export interface BtwMessage {
  role: "user" | "assistant"
  text: string
}

export function userMsg(text: string): BtwMessage {
  return { role: "user", text }
}

export function assistantMsg(text: string): BtwMessage {
  return { role: "assistant", text }
}

export interface BtwThread {
  id: string
  anchor: string
  paragraphIndex: number
  exchangeId: string
  messages: BtwMessage[]
  streaming: boolean
  streamText: string
}

export interface SourceRef {
  label: string
  type: "article" | "raw" | "search"
}

export interface ThinkingBlock {
  sources: SourceRef[]
}

export interface Exchange {
  id: string
  query: string
  thinking: ThinkingBlock[]
  answer: string
  btws: BtwThread[]
}

export interface SelectionInfo {
  text: string
  x: number
  y: number
  paragraphIndex: number
  exchangeId: string
}

export type Phase = "idle" | "searching" | "streaming" | "done"
