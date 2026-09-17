import { type Uuid, Uuid as UuidSchema } from "@great-minds/domain";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { convertLegacySession, splitSessionConversations } from "../scripts/migrate-session-replies.ts";
import { StoredSessionEvent } from "../src/sessions.ts";

const uuid = (value: string) => Schema.decodeUnknownSync(UuidSchema)(value);
const encodeStoredEvent = Schema.encodeSync(StoredSessionEvent);

const ts = "2026-07-23T12:00:00.000Z";

const legacyMeta = {
  type: "meta",
  id: "session-1",
  query: "First question",
  ts,
  user_id: "00000000-0000-4000-8000-000000000001",
  origin: {
    doc_path: "raw/books/capital.md",
    origin_scope: "vault",
    anchor: "anchor quote",
    paragraph: "Full paragraph",
    paragraph_index: 4,
  },
};

const legacyExchange = (
  exId: string,
  query: string,
  answer: string,
  replyId: string,
  duplicate = false,
) => ({
  type: "exchange",
  exId,
  ...(duplicate ? {} : { reply_id: replyId }),
  query,
  thinking: [],
  answer,
  ts: duplicate ? "2026-07-23T12:02:00.000Z" : ts,
});

const legacyBtw = {
  type: "btw",
  exId: "ex-1",
  reply_id: "00000000-0000-4000-8000-000000000301",
  quote: "BTW quote",
  blockOffset: 2,
  context: "BTW paragraph",
  exchanges: [
    {
      query: "BTW one",
      thinking: [],
      answer: "BTW one answer.",
    },
    {
      query: "BTW two",
      thinking: [],
      answer: "BTW two answer.",
    },
  ],
  ts: "2026-07-23T12:03:00.000Z",
};

describe("convertLegacySession", () => {
  it("converts legacy meta/exchange/btw events into reply nodes", () => {
    let counter = 0;
    // Record every id minted by the conversion, in mint order, so the expected
    // output can reference exactly what the mint function produced.
    const mints: Uuid[] = [];
    const mintId = () => {
      const value = uuid(
        `00000000-0000-4000-8000-${String(500 + counter++).padStart(12, "0")}`,
      );
      mints.push(value);
      return value;
    };

    const converted = convertLegacySession(
      [
        legacyMeta,
        legacyExchange(
          "ex-1",
          "First question",
          "First answer.",
          "00000000-0000-4000-8000-000000000101",
        ),
        legacyExchange(
          "ex-2",
          "Second question",
          "",
          "00000000-0000-4000-8000-000000000102",
          true,
        ),
        legacyExchange(
          "ex-2",
          "Second question",
          "Second answer.",
          "00000000-0000-4000-8000-000000000103",
        ),
        legacyBtw,
      ],
      mintId,
    );

    expect(converted).toHaveLength(5);
    const nodes = converted.filter((event) => event.type === "reply");
    const mainLine = nodes.filter((node) => node.btw === undefined);
    const thread = nodes.filter((node) => node.btw !== undefined);

    expect(converted[0]).toMatchObject({ type: "meta", query: "First question" });
    // Legacy "ex-1"/"ex-2" are not uuids and must not leak through; the
    // main-line nodes carry the freshly minted uuids in fixture order.
    expect(mainLine.map((node) => node.exchange_id)).toEqual([mints[0], mints[1]]);
    expect(mainLine.map((node) => node.exchange_id)).not.toContain("ex-1");
    expect(mainLine.map((node) => node.exchange_id)).not.toContain("ex-2");
    expect(mainLine[0]).toMatchObject({
      reply_id: "00000000-0000-4000-8000-000000000101",
      parent_reply_id: null,
      status: "completed",
      question: "First question",
      answer: "First answer.",
    });
    expect(mainLine[0]?.messages).toEqual([
      {
        role: "user",
        content: 'Passage:\n> Full paragraph\n\nHighlighted: "anchor quote"\n\nFirst question',
      },
      { role: "assistant", content: "First answer." },
    ]);
    expect(mainLine[1]).toMatchObject({
      reply_id: "00000000-0000-4000-8000-000000000103",
      parent_reply_id: "00000000-0000-4000-8000-000000000101",
      status: "completed",
      question: "Second question",
      answer: "Second answer.",
    });
    expect(mainLine[1]?.messages).toEqual([
      { role: "user", content: "Second question" },
      { role: "assistant", content: "Second answer." },
    ]);

    // Each BTW turn gets its own fresh uuid exchange id.
    expect(thread).toHaveLength(2);
    expect(thread[0]).toMatchObject({
      parent_reply_id: "00000000-0000-4000-8000-000000000103",
      status: "completed",
      question: "BTW one",
      btw: {
        quote: "BTW quote",
        block_offset: 2,
        context: "BTW paragraph",
      },
    });
    expect(thread[1]).toMatchObject({
      reply_id: "00000000-0000-4000-8000-000000000301",
      parent_reply_id: thread[0]?.reply_id,
      status: "completed",
      question: "BTW two",
      answer: "BTW two answer.",
    });
    // The BTW anchor points at the *new* id of the owning main-line exchange
    // (legacy "ex-1" was minted first), never at the legacy string.
    for (const node of thread) {
      expect(node.btw?.exchange_id).toBe(mints[0]);
      expect(node.btw?.exchange_id).not.toBe("ex-1");
    }
    expect(thread.map((node) => node.exchange_id)).not.toContain("ex-1");
    expect(thread.map((node) => node.exchange_id)).not.toContain("ex-2");

    // Total mint order: ex-1 main-line id, ex-2 main-line id, then for the
    // two BTW turns a reply id and a turn exchange id each.
    expect(mints).toHaveLength(5);
    expect(mints[0]).not.toBe(mints[1]);
    expect(thread[0]?.reply_id).toBe(mints[2]);
    expect(thread[0]?.exchange_id).toBe(mints[3]);
    expect(thread[1]?.exchange_id).toBe(mints[4]);
  });

  it("returns reply-format events unchanged on a second run", () => {
    let counter = 0;
    const mintId = () =>
      uuid(`00000000-0000-4000-8000-${String(700 + counter++).padStart(12, "0")}`);
    const converted = convertLegacySession(
      [
        legacyMeta,
        legacyExchange(
          "ex-1",
          "First question",
          "First answer.",
          "00000000-0000-4000-8000-000000000101",
        ),
      ],
      mintId,
    );
    const replay = convertLegacySession(converted.map((event) => encodeStoredEvent(event)), mintId);
    expect(replay).toEqual(converted);
  });

  it("uses the first saved BTW snapshot to freeze context, even after later main replies", () => {
    let counter = 800;
    const converted = convertLegacySession([
      { ...legacyMeta, origin: null },
      legacyExchange("ex-1", "First question", "First answer.", "00000000-0000-4000-8000-000000000101"),
      { ...legacyBtw, exchanges: legacyBtw.exchanges.slice(0, 1), ts: "2026-07-23T12:01:00.000Z" },
      { ...legacyExchange("ex-2", "Later main question", "Later main answer.", "00000000-0000-4000-8000-000000000102"), ts: "2026-07-23T12:02:00.000Z" },
      legacyBtw,
    ], () => uuid(`00000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`));
    const thread = converted.filter((event) => event.type === "reply" && event.btw !== undefined);
    expect(thread[0]).toMatchObject({
      parent_reply_id: "00000000-0000-4000-8000-000000000101",
      ts: new Date("2026-07-23T12:01:00.000Z"),
    });
  });

  it("splits answer BTWs into stable identities without losing their transcript or passage", () => {
    let counter = 900;
    const converted = convertLegacySession([
      { ...legacyMeta, origin: null },
      legacyExchange("ex-1", "First question", "First answer.", "00000000-0000-4000-8000-000000000101"),
      legacyBtw,
    ], () => uuid(`00000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`));
    const vaultId = uuid("00000000-0000-4000-8000-000000000001");
    const result = splitSessionConversations(converted, vaultId, "session");
    expect(splitSessionConversations(converted, vaultId, "session")).toEqual(result);
    expect(result).toHaveLength(2);
    const [parent, child] = result;
    expect(parent?.events.map((event) => event.type)).toEqual(["meta", "reply"]);
    expect(child?.kind).toBe("btw");
    expect(child?.origin).toMatchObject({
      kind: "answer", session_id: legacyMeta.id, anchor: "BTW quote",
      paragraph: "BTW paragraph", paragraph_index: 2,
    });
    expect(child?.events[0]).toMatchObject({
      context: { session_id: legacyMeta.id, reply_id: "00000000-0000-4000-8000-000000000101" },
    });
    const ownTurns = child!.events.filter((event) => event.type === "reply");
    expect(ownTurns.map((node) => node.question)).toEqual(["BTW one", "BTW two"]);
    expect(ownTurns[0]?.parent_reply_id).toBeNull();
    expect(ownTurns[1]?.parent_reply_id).toBe(ownTurns[0]?.reply_id);
    expect(ownTurns[0]?.messages[0]?.content).toContain('Highlighted: "BTW quote"');
    expect(ownTurns[1]?.reply_id).toBe(legacyBtw.reply_id);
    expect(ownTurns.every((node) => !("btw" in node))).toBe(true);
    expect(splitSessionConversations(child!.events, vaultId, "btw")).toEqual([child]);
    expect(() => splitSessionConversations(converted, vaultId, "btw")).toThrow("historical nested BTWs");
    expect(() => splitSessionConversations(converted.filter((event) => event.type !== "reply" || event.btw !== undefined), vaultId, "session")).toThrow("missing answer anchor");
  });
});
