import type { SessionEvent } from "@great-minds/domain";
import { describe, expect, it } from "vitest";

import { dedupeSessionExchanges, renderSessionMarkdown } from "../src/sessions.ts";

const ts = "2026-07-23T12:00:00.000Z";

describe("session event replay", () => {
  it("keeps the last exchange value in the original turn position", () => {
    const events: SessionEvent[] = [
      {
        type: "meta",
        id: "session-1",
        query: "First question",
        ts,
        user_id: "00000000-0000-4000-8000-000000000001",
      },
      {
        type: "exchange",
        exId: "ex-1",
        query: "First question",
        thinking: [],
        answer: "",
        ts,
      },
      {
        type: "exchange",
        exId: "ex-2",
        query: "Second question",
        thinking: [],
        answer: "Second answer",
        ts,
      },
      {
        type: "exchange",
        exId: "ex-1",
        query: "First question",
        thinking: [],
        answer: "First answer",
        ts,
      },
    ];

    const deduped = dedupeSessionExchanges(events);
    expect(deduped.filter((event) => event.type === "exchange")).toEqual([
      expect.objectContaining({ exId: "ex-1", answer: "First answer" }),
      expect.objectContaining({ exId: "ex-2", answer: "Second answer" }),
    ]);
    const markdown = renderSessionMarkdown(events);
    expect(markdown.match(/^# First question$/gmu)).toHaveLength(1);
    expect(markdown.indexOf("# First question")).toBeLessThan(markdown.indexOf("# Second question"));
  });

  it("leaves legacy non-duplicate exchanges unchanged", () => {
    const events: SessionEvent[] = [
      {
        type: "exchange",
        exId: "legacy",
        query: "Legacy question",
        thinking: [],
        answer: "Legacy answer",
        ts,
      },
    ];

    expect(dedupeSessionExchanges(events)).toEqual(events);
  });
});
