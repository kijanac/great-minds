export interface BtwMessage {
  role: "user" | "assistant"
  text: string
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

export interface Exchange {
  id: string
  query: string
  cards: string[]
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
