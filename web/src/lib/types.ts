import type { ReplySource, Uuid } from "@great-minds/domain";
import type { UnmentionedLink } from "$lib/api/lint";
import type { SessionSummary } from "$lib/api/sessions";
import type { SourceDocumentSummary, SourceTypeFacet } from "$lib/api/sources";
import type { WikiArticleOverview } from "$lib/api/wiki";
import type { Btw } from "$lib/btw.svelte";

export type SourceRef = ReplySource;

export type {
  SessionSummary,
  SourceDocumentSummary,
  SourceTypeFacet,
  UnmentionedLink,
  WikiArticleOverview,
};

export interface ThinkingBlock {
  sources: readonly SourceRef[];
}

export interface Exchange {
  id: Uuid;
  query: string;
  thinking: readonly ThinkingBlock[];
  answer: string;
  btws: Btw[];
  replyId?: Uuid;
  error?: string | null;
  stopped?: boolean;
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

export interface ThreadLike {
  id: string;
  conversation: Pick<SessionSummary, "id" | "kind" | "query"> | null;
  error?: string | null;
  promoting?: boolean;
  anchor: TextAnchor;
  exchanges: Exchange[];
  draft: boolean;
  createdAt: Date | null;
}

export interface SelectionInfo extends TextAnchor {
  rect: DOMRect;
  exchangeId: Uuid;
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
