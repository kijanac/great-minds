import { Result } from "effect";
import { describe, expect, it } from "vitest";

import { parseHistory } from "../src/conversation-history/history.ts";
import {
  projectSession,
  publicationExchanges,
  renderSessionMarkdown,
} from "../src/conversation-history/presentation.ts";
import {
  attempt,
  header,
  historyBytes,
  parentId,
  replyId,
  sessionId,
  settlement,
  uuid,
} from "./fixtures/conversation-history.ts";

const project = (writes: readonly object[]) => {
  const parsed = parseHistory(sessionId, historyBytes(writes));
  if (Result.isFailure(parsed)) throw parsed.failure;
  return projectSession(parsed.success);
};

describe("native session projection", () => {
  it("selects the latest accepted attempt without moving its exchange", () => {
    const projected = project([
      header(),
      attempt({ question: "First question" }),
      settlement({ outcome: { status: "failed", code: "generation_failed", message: "Failed" } }),
      attempt({ reply_id: uuid(102), exchange_id: uuid(202), question: "Second question" }),
      settlement({ reply_id: uuid(102), answer: "Second answer" }),
      attempt({ reply_id: uuid(103), previous_attempt_id: replyId, question: "First question" }),
      settlement({ reply_id: uuid(103), answer: "First answer" }),
    ]);
    expect(projected.filter((event) => event.type === "exchange")).toEqual([
      expect.objectContaining({
        exId: uuid(201),
        reply_id: uuid(103),
        answer: "First answer",
        status: "completed",
      }),
      expect.objectContaining({ exId: uuid(202), answer: "Second answer", status: "completed" }),
    ]);
    const markdown = renderSessionMarkdown(projected);
    expect(markdown.match(/^# First question$/gmu)).toHaveLength(1);
    expect(markdown.indexOf("# First question")).toBeLessThan(
      markdown.indexOf("# Second question"),
    );
  });

  it("projects only a child's own turns and does not expose retained model context", () => {
    const events = project([
      header({
        origin: {
          kind: "answer",
          session_id: parentId,
          exchange_id: uuid(901),
          anchor: "A passage",
          paragraph: "A passage",
          paragraph_index: 0,
        },
        anchor_reply_id: uuid(902),
        context: { session_id: parentId, reply_id: uuid(902) },
      }),
      attempt({ question: "First BTW" }),
      settlement({
        answer: "First BTW answer",
        context_messages: [{ role: "assistant", content: "Private tool result" }],
      }),
      attempt({
        reply_id: uuid(102),
        exchange_id: uuid(202),
        parent_reply_id: replyId,
        question: "Second BTW",
      }),
      settlement({ reply_id: uuid(102), answer: "Second BTW answer" }),
    ]);
    expect(events.filter((event) => event.type === "exchange")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("Private tool result");
    expect(events[0]).not.toHaveProperty("context");
    expect(renderSessionMarkdown(events)).toContain("# First BTW");
    expect(renderSessionMarkdown(events)).toContain("# Second BTW");
  });

  it("distinguishes pending work from an empty completed answer", () => {
    expect(project([header(), attempt()])[1]).toMatchObject({
      status: "running",
      answer: "",
      thinking: [],
    });
    expect(
      project([header(), attempt(), settlement({ answer: "", sources: [] })])[1],
    ).toMatchObject({ status: "completed", answer: "" });
    expect(renderSessionMarkdown(project([header(), attempt()]))).toContain(
      "Response in progress.",
    );
  });

  it("keeps unknown historical settlement time unknown", () => {
    expect(project([header(), attempt(), settlement({ settled_at: null })])[1]).toMatchObject({
      ts: null,
    });
  });

  it("retains visible tool activity separately from private tool messages", () => {
    const result = settlement();
    expect(project([header(), attempt(), result])[1]).toMatchObject({
      thinking: [{ sources: result.sources }],
    });
    expect(renderSessionMarkdown(project([header(), attempt(), result]))).toContain(
      "`raw/source.md`",
    );
  });

  it("retains failed partials privately but excludes them from publication", () => {
    const events = project([
      header(),
      attempt(),
      settlement({
        answer: "A private failed partial",
        outcome: { status: "failed", code: "external_outcome_unknown", message: "Not repeated" },
      }),
    ]);
    expect(events[1]).toMatchObject({
      status: "failed",
      answer: "A private failed partial",
      error: "Not repeated",
    });
    expect(renderSessionMarkdown(events)).toContain("Response failed.");
    expect(renderSessionMarkdown(publicationExchanges(events))).not.toContain(
      "A private failed partial",
    );
    expect(publicationExchanges(events)).toEqual([]);
  });

  it("publishes completed and stopped answers but not an accepted unsettled turn", () => {
    const events = project([
      header(),
      attempt(),
      settlement({ outcome: { status: "stopped" } }),
      attempt({ reply_id: uuid(102), exchange_id: uuid(202), parent_reply_id: replyId }),
    ]);
    expect(publicationExchanges(events)).toHaveLength(1);
    expect(publicationExchanges(events)[0].status).toBe("stopped");
    expect(renderSessionMarkdown(publicationExchanges(events))).toContain("Response stopped.");
  });
});
