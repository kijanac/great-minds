import type {
  Citation,
  ReplySource,
  SessionExchangeEvent,
  SessionId,
  Uuid,
} from "@great-minds/domain";
import type { UnmentionedLink } from "#lib/api/lint.ts";
import type { SessionSummary } from "#lib/api/sessions.ts";
import type { SourceDocumentSummary, SourceTypeFacet } from "#lib/api/sources.ts";
import type { WikiArticleOverview } from "#lib/api/wiki.ts";
import type { Conversation } from "#lib/conversation.svelte.ts";

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
  citations: readonly Citation[];
  btws: Conversation[];
  replyId?: Uuid;
  error?: string | null;
  status: SessionExchangeEvent["status"];
  version: number | null;
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
  sessionId: SessionId | null;
  anchor: TextAnchor;
  exchanges: Exchange[];
  draft: boolean;
  createdAt: Date | null;
}

export interface SelectionInfo extends TextAnchor {
  passage: string;
  rect: DOMRect;
  exchangeId: Uuid;
}

export type Phase = "idle" | "searching" | "streaming" | "finalizing" | "done";

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
