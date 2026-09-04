import { SessionId, Uuid } from "@great-minds/domain";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  projectSession,
  renderSessionMarkdown,
  type ReplyNode,
  type StoredSessionEvent,
} from "../src/sessions.ts";

const uuid = (value: string) => Schema.decodeUnknownSync(Uuid)(value);
const sessionId = (value: string) => Schema.decodeUnknownSync(SessionId)(value);

const EX_1 = uuid("00000000-0000-4000-8000-000000000301");
const EX_2 = uuid("00000000-0000-4000-8000-000000000302");
const BTW_1 = uuid("00000000-0000-4000-8000-000000000303");
const BTW_2 = uuid("00000000-0000-4000-8000-000000000304");

const ts = "2026-07-23T12:00:00.000Z";

const meta: StoredSessionEvent = {
  type: "meta",
  id: sessionId("session-1"),
  query: "First question",
  ts,
  user_id: uuid("00000000-0000-4000-8000-000000000001"),
  origin: null,
};

const node = (overrides: Partial<ReplyNode>): ReplyNode => ({
  type: "reply",
  reply_id: uuid("00000000-0000-4000-8000-000000000101"),
  parent_reply_id: null,
  exchange_id: EX_1,
  question: "Question",
  status: "completed",
  messages: [{ role: "user", content: "Question" }],
  sources: [],
  answer: "Answer",
  ts,
  ...overrides,
});

describe("session projection", () => {
  it("keeps the latest node per exchange id in the original position", () => {
    const events: StoredSessionEvent[] = [
      meta,
      node({
        exchange_id: EX_1,
        question: "First question",
        status: "pending",
        messages: [],
        sources: [],
        answer: "",
        reply_id: uuid("00000000-0000-4000-8000-000000000101"),
      }),
      node({
        exchange_id: EX_2,
        question: "Second question",
        answer: "Second answer",
        reply_id: uuid("00000000-0000-4000-8000-000000000102"),
      }),
      node({
        exchange_id: EX_1,
        question: "First question",
        answer: "First answer",
        reply_id: uuid("00000000-0000-4000-8000-000000000103"),
      }),
    ];

    const projected = projectSession(events);
    expect(projected.filter((event) => event.type === "exchange")).toEqual([
      expect.objectContaining({
        exId: EX_1,
        reply_id: uuid("00000000-0000-4000-8000-000000000103"),
        answer: "First answer",
      }),
      expect.objectContaining({ exId: EX_2, answer: "Second answer" }),
    ]);
    const markdown = renderSessionMarkdown(projected);
    expect(markdown.match(/^# First question$/gmu)).toHaveLength(1);
    expect(markdown.indexOf("# First question")).toBeLessThan(markdown.indexOf("# Second question"));
  });

  it("projects a BTW thread of two turns into one btw event", () => {
    const events: StoredSessionEvent[] = [
      meta,
      node({
        exchange_id: EX_1,
        question: "Parent question",
        answer: "Parent answer",
        reply_id: uuid("00000000-0000-4000-8000-000000000101"),
      }),
      node({
        exchange_id: BTW_1,
        question: "First BTW",
        answer: "First BTW answer",
        parent_reply_id: uuid("00000000-0000-4000-8000-000000000101"),
        btw: {
          exchange_id: EX_1,
          quote: "Parent answer",
          block_offset: 0,
          context: "Parent answer.",
        },
        reply_id: uuid("00000000-0000-4000-8000-000000000102"),
      }),
      node({
        exchange_id: BTW_2,
        question: "Second BTW",
        answer: "Second BTW answer",
        parent_reply_id: uuid("00000000-0000-4000-8000-000000000102"),
        btw: {
          exchange_id: EX_1,
          quote: "Parent answer",
          block_offset: 0,
          context: "Parent answer.",
        },
        reply_id: uuid("00000000-0000-4000-8000-000000000103"),
      }),
    ];

    const projected = projectSession(events);
    expect(projected.filter((event) => event.type === "exchange")).toEqual([
      expect.objectContaining({ exId: EX_1, answer: "Parent answer" }),
    ]);
    const btwEvents = projected.filter((event) => event.type === "btw");
    expect(btwEvents).toHaveLength(1);
    expect(btwEvents[0]).toMatchObject({
      exId: EX_1,
      quote: "Parent answer",
      reply_id: uuid("00000000-0000-4000-8000-000000000103"),
      blockOffset: 0,
      context: "Parent answer.",
      exchanges: [
        {
          exchange_id: BTW_1,
          query: "First BTW",
          answer: "First BTW answer",
        },
        {
          exchange_id: BTW_2,
          query: "Second BTW",
          answer: "Second BTW answer",
        },
      ],
    });
    const markdown = renderSessionMarkdown(projected);
    expect(markdown).toContain("> First BTW");
    expect(markdown).toContain("> Second BTW");
  });

  it("projects a pending node with an empty answer and no thinking", () => {
    const events: StoredSessionEvent[] = [
      meta,
      node({
        exchange_id: EX_1,
        question: "Pending question",
        status: "pending",
        messages: [],
        sources: [],
        answer: "",
        reply_id: uuid("00000000-0000-4000-8000-000000000101"),
      }),
    ];

    const projected = projectSession(events);
    expect(projected.filter((event) => event.type === "exchange")).toEqual([
      expect.objectContaining({ exId: EX_1, answer: "", thinking: [] }),
    ]);
  });
});
