import type { SourceRef, ThinkingBlock } from "$lib/api/schemas";

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
  // In-flight while the answer streams; false once committed/persisted.
  streaming: boolean;
}

// Where a BTW is anchored: the source offset of its block (exact, stable,
// render-independent identity) plus the quoted span within that block.
// `context` is the full text of the block, carried for the LLM prompt only —
// never used for placement or resolution.
export interface TextAnchor {
  blockOffset: number;
  quote: string;
  context: string;
}

export interface BtwThread {
  id: string;
  exchangeId: string;
  anchor: TextAnchor;
  // The last turn carries streaming: true while it's in flight.
  exchanges: Exchange[];
}

export interface SelectionInfo extends TextAnchor {
  x: number;
  y: number;
  exchangeId: string;
}

export type Phase = "idle" | "searching" | "streaming" | "done";

export interface DroppedFile {
  file: File;
  path: string;
}
