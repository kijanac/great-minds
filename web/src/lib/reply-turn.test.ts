import { SessionId, Uuid, type ReplySnapshot } from "@great-minds/domain";
import { describe, expect, it } from "vitest";
import { applyReplySnapshot } from "#lib/reply-turn.ts";
import type { Exchange } from "#lib/types.ts";

const replyId = Uuid.make("00000000-0000-4000-8000-000000000001");
const retryId = Uuid.make("00000000-0000-4000-8000-000000000002");
const exchange = (overrides: Partial<Exchange> = {}): Exchange => ({
  id: Uuid.make("00000000-0000-4000-8000-000000000003"),
  replyId,
  status: "running",
  version: 7,
  query: "Question",
  answer: "Hydrated partial",
  citations: [],
  sources: [],
  btws: [],
  error: null,
  ...overrides,
});
const snapshot = (overrides: Partial<ReplySnapshot> = {}): ReplySnapshot => ({
  reply_id: replyId,
  session_id: SessionId.make("00000000-0000-4000-8000-000000000007"),
  status: "running",
  version: 8,
  answer: "New partial",
  citations: [],
  sources: [],
  error: null,
  created_at: new Date("2026-10-11T12:00:00.000Z"),
  updated_at: new Date("2026-10-11T12:00:00.000Z"),
  ...overrides,
});

describe("reply observation merge", () => {
  it.each([6, 7])("ignores same-attempt version %i behind the hydrated version", (version) => {
    expect(applyReplySnapshot(exchange(), snapshot({ version }))).toBeNull();
  });

  it("compares versions only within the current reply identity", () => {
    const retry = exchange({ replyId: retryId, version: null, answer: "" });
    expect(applyReplySnapshot(retry, snapshot({ version: 900 }))).toBeNull();
    expect(applyReplySnapshot(retry, snapshot({ reply_id: retryId, version: 1 }))).toMatchObject({
      exchange: { replyId: retryId, version: 1, answer: "New partial" },
    });
  });

  it.each(["completed", "stopped", "failed"] as const)(
    "preserves recorded %s content while operation readiness catches up",
    (status) => {
      const saved = exchange({
        status,
        version: null,
        answer: "Recorded answer",
        error: status === "failed" ? "Recorded failure" : null,
      });
      const progress = snapshot({ version: 99, answer: "Stale DB partial" });
      const merged = applyReplySnapshot(saved, progress)!;
      expect(merged).toMatchObject({
        exchange: { status, answer: "Recorded answer", error: saved.error, version: 99 },
        activity: { reply_id: replyId, status: "settling" },
      });
      const terminal = snapshot({
        status: "completed",
        version: 100,
        answer: "Different cache",
      });
      expect(applyReplySnapshot(merged.exchange, terminal)).toMatchObject({
        exchange: { status, answer: "Recorded answer" },
        activity: null,
      });
    },
  );

  it("keeps settling nonterminal and separates it from the answer outcome", () => {
    const progress = snapshot({ status: "settling" });
    const merged = applyReplySnapshot(exchange(), progress)!;
    expect(merged).toMatchObject({
      exchange: { status: "running", answer: "New partial", version: 8 },
      activity: { reply_id: replyId, status: "settling" },
    });
    const terminal = snapshot({ status: "completed", version: 9, answer: "" });
    expect(applyReplySnapshot(merged.exchange, terminal)).toMatchObject({
      exchange: { status: "completed", answer: "" },
      activity: null,
    });
  });
});
