import type { SourceRef, ThinkingBlock } from "@/api/schemas";

export type { SourceRef, ThinkingBlock };

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Exchange {
  id: string;
  query: string;
  thinking: ThinkingBlock[];
  answer: string;
  btws: BtwThread[];
}

export interface BtwThread {
  id: string;
  anchor: string;
  paragraph: string;
  paragraphIndex: number;
  exchangeId: string;
  exchanges: Exchange[];
  // In-flight state — set during streaming, cleared when the new exchange lands:
  pendingQuery: string | null;
  streaming: boolean;
  streamText: string;
  sources: SourceRef[];
}

export interface SelectionInfo {
  text: string;
  x: number;
  y: number;
  paragraphIndex: number;
  exchangeId: string;
  paragraph: string;
}

export type Phase = "idle" | "searching" | "streaming" | "done";

export interface DroppedFile {
  file: File;
  path: string;
}
