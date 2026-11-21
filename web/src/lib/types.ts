import type {
  Citation,
  Passage,
  ReplySource,
  SessionExchange,
  SessionId,
  Uuid,
} from "@great-minds/domain";
import type { SessionSummary } from "#lib/api/sessions.ts";
import type { SourceDocumentSummary, SourceTypeFacet } from "#lib/api/sources.ts";
import type { WikiArticleOverview } from "#lib/api/wiki.ts";
import type { Conversation } from "#lib/conversation.svelte.ts";

export type SourceRef = ReplySource;

export type {
  SessionSummary,
  SourceDocumentSummary,
  SourceTypeFacet,
  WikiArticleOverview,
};

export interface Exchange {
  id: Uuid;
  query: string;
  sources: readonly SourceRef[];
  answer: string;
  citations: readonly Citation[];
  btws: Conversation[];
  replyId?: Uuid;
  error?: string | null;
  status: SessionExchange["status"];
  version: number | null;
  startedAt?: Date;
}

export interface ThreadLike {
  id: string;
  sessionId: SessionId | null;
  passage: Passage | null;
  exchanges: Exchange[];
  draft: boolean;
  createdAt: Date | null;
}

export interface SelectionInfo {
  passage: Passage;
  excerpt: string;
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
