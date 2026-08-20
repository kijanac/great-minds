import type { SourceRef, ThinkingBlock } from "$lib/api/schemas";
import type { UnmentionedLink } from "$lib/api/lint";
import type { SessionSummary } from "$lib/api/sessions";
import type { SourceDocumentSummary, SourceTypeFacet } from "$lib/api/sources";
import type { WikiArticleOverview } from "$lib/api/wiki";

export type {
  SessionSummary,
  SourceDocumentSummary,
  SourceRef,
  SourceTypeFacet,
  ThinkingBlock,
  UnmentionedLink,
  WikiArticleOverview,
};

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
  replyId?: string;
  error?: string | null;
  // In-flight while the server-owned reply is running.
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

// A renderable annotation thread. Doc-born sessions (persistent) carry
// sessionId/draft/anchored/createdAt; session-scoped BTW threads carry only
// the base fields (optionals stay undefined).
export interface ThreadLike {
  id: string;
  anchor: TextAnchor;
  exchanges: Exchange[];
  sessionId?: string | null;
  draft?: boolean;
  createdAt?: string | null;
}

// A doc-born session as surfaced by the reader: an anchored note thread or a
// doc-initiated conversation (anchored=false, no span in the body).
export interface DocThread extends ThreadLike {
  sessionId: string | null;
  draft: boolean;
  anchored: boolean;
  createdAt: string | null;
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

export interface ReferencePromotionAction {
  vaultName: string;
  pending: boolean;
  error: string | null;
  onPromote: () => Promise<void>;
}
