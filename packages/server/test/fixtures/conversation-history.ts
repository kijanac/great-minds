import { FileFingerprint, SessionId, Uuid } from "@great-minds/domain";
import { Schema } from "effect";

import { HistoryTimestamp, type HistoryWrite } from "../../src/conversation-history/schema.ts";
import type { ReplySettlementResult } from "../../src/conversation-history/settlement.ts";
import { promptContentHash } from "../../src/crypto.ts";

export const sessionId = Schema.decodeUnknownSync(SessionId)("history-session");
export const parentId = Schema.decodeUnknownSync(SessionId)("parent-session");
export const uuid = (suffix: number) =>
  Schema.decodeUnknownSync(Uuid)(`00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`);
export const vaultId = uuid(1);
export const replyId = uuid(101);
export const time = Schema.decodeUnknownSync(HistoryTimestamp);
export const timestamp = time("2026-10-10T12:00:00.000Z");

export const header = (
  overrides: Partial<Extract<HistoryWrite, { type: "conversation" }>> = {},
): Extract<HistoryWrite, { type: "conversation" }> => ({
  type: "conversation",
  format: "great-minds/conversation",
  version: 1,
  session_id: sessionId,
  created_at: timestamp,
  author_id: uuid(2),
  origin: null,
  anchor_reply_id: null,
  context: null,
  ...overrides,
});

export const attempt = (
  overrides: Partial<Extract<HistoryWrite, { type: "attempt" }>> = {},
): Extract<HistoryWrite, { type: "attempt" }> => ({
  type: "attempt",
  reply_id: replyId,
  exchange_id: uuid(201),
  previous_attempt_id: null,
  parent_reply_id: null,
  question: "What does this passage mean?",
  accepted_at: timestamp,
  ...overrides,
});

export const settlement = (
  overrides: Partial<Extract<HistoryWrite, { type: "settlement" }>> = {},
): Extract<HistoryWrite, { type: "settlement" }> => ({
  type: "settlement",
  reply_id: replyId,
  settled_at: timestamp,
  outcome: { status: "completed" },
  answer: "A considered answer. é 漢字 [^1]",
  sources: [
    {
      type: "raw",
      label: "raw/source.md",
      document_id: null,
      title: "Original source title",
      scope: null,
      path: null,
      thinking: null,
      ranges: [{ start: 2, end: 4 }],
      full: false,
    },
  ],
  context_messages: [
    { role: "user", content: "What does this passage mean?" },
    { role: "assistant", content: "A considered answer. é 漢字 [^1]" },
  ],
  generation: {
    mode: "btw",
    system_prompt_hash: {
      scheme: "gm-prompt-v1",
      value: Schema.decodeUnknownSync(FileFingerprint)(promptContentHash("Be concise. é 漢字")),
    },
    requested_model: "test/model",
    last_model: "test/model",
  },
  ...overrides,
});

export const completion = (): Extract<ReplySettlementResult, { status: "completed" }> => {
  const result = settlement();
  if (result.generation === null || result.context_messages === null)
    throw new Error("Completed fixture requires generation metadata and context");
  return {
    status: "completed",
    answer: result.answer,
    sources: result.sources,
    context_messages: result.context_messages,
    generation: result.generation,
  };
};

export const historyBytes = (writes: readonly object[]) =>
  new TextEncoder().encode(
    writes.map((write, index) => JSON.stringify({ ...write, seq: index + 1 })).join("\n") + "\n",
  );
