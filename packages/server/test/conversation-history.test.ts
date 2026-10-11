import { FileFingerprint, SessionId } from "@great-minds/domain";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  inspectHistoryDependencies,
  parseHistory,
  planHistoryAppend,
  verifyHistoryReceipt,
} from "../src/conversation-history/history.ts";
import { promptContentHash, rawFileHash, sha256Hex } from "../src/crypto.ts";
import {
  attempt,
  header,
  historyBytes,
  parentId,
  replyId,
  sessionId,
  settlement,
  time,
  uuid,
} from "./fixtures/conversation-history.ts";

const success = <Value, Error>(result: Result.Result<Value, Error>): Value => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

const failure = <Value, Error>(result: Result.Result<Value, Error>): Error => {
  expect(result._tag).toBe("Failure");
  if (Result.isSuccess(result)) throw new Error("Expected failure");
  return result.failure;
};

const parse = (writes: readonly object[], id = sessionId) =>
  success(parseHistory(id, historyBytes(writes)));

const failed = () =>
  settlement({
    outcome: { status: "failed", code: "generation_failed", message: "Answer interrupted." },
    answer: "Partial answer",
  });

describe("conversation history format", () => {
  it.each(["completed", "stopped", "failed"] as const)(
    "preserves %s outcomes, Unicode and exact references",
    (status) => {
      const terminal = status === "failed" ? failed() : settlement({ outcome: { status } });
      const history = parse([header(), attempt(), terminal]);
      expect(history.turns[0].attempts[0].settlement).toMatchObject(terminal);
      expect(history.revision).toEqual({
        last_seq: 3,
        sha256: rawFileHash(historyBytes([header(), attempt(), terminal])),
      });
      expect(history.header.session_id).toBe("history-session");
    },
  );

  it("distinguishes a completed empty answer from a pending attempt", () => {
    const pending = parse([header(), attempt()]);
    const completed = parse([header(), attempt(), settlement({ answer: "" })]);
    expect(pending.turns[0].attempts[0].settlement).toBeNull();
    expect(completed.turns[0].attempts[0].settlement?.outcome.status).toBe("completed");
  });

  it("retains failed attempts without selecting them over a later accepted retry", () => {
    const history = parse([
      header(),
      attempt(),
      failed(),
      attempt({ reply_id: uuid(102), previous_attempt_id: replyId }),
      settlement({ reply_id: uuid(102) }),
    ]);
    expect(history.turns).toHaveLength(1);
    expect(history.turns[0].selected_reply_id).toBe(uuid(102));
    expect(history.turns[0].attempts.map((value) => value.settlement?.outcome.status)).toEqual([
      "failed",
      "completed",
    ]);
  });

  it("keeps acceptance order when an older attempt settles after its replacement", () => {
    const history = parse([
      header(),
      attempt(),
      attempt({ reply_id: uuid(102), previous_attempt_id: replyId }),
      settlement({ reply_id: uuid(102) }),
      failed(),
    ]);
    expect(history.turns[0].selected_reply_id).toBe(uuid(102));
  });

  it("orders turns by acceptance rather than settlement or timestamp", () => {
    const history = parse([
      header(),
      attempt(),
      attempt({
        reply_id: uuid(102),
        exchange_id: uuid(202),
        accepted_at: time("2020-01-01T00:00:00.000Z"),
      }),
      settlement({ reply_id: uuid(102) }),
      settlement(),
    ]);
    expect(history.turns.map((turn) => turn.exchange_id)).toEqual([uuid(201), uuid(202)]);
  });

  it.each([
    [
      "unsupported format",
      [header({ version: 1 }), attempt()].map((value, index) =>
        index === 0 ? { ...value, version: 2 } : value,
      ),
      "unsupported_format",
    ],
    ["unknown type", [header(), attempt(), { type: "new-event" }], "invalid_record"],
    [
      "unknown nested field",
      [
        header(),
        attempt(),
        { ...settlement(), sources: [{ ...settlement().sources[0], pending: true }] },
      ],
      "invalid_record",
    ],
    [
      "invalid timestamp",
      [header(), { ...attempt(), accepted_at: "2026-02-30T00:00:00.000Z" }],
      "invalid_record",
    ],
    ["unsafe UUID", [header(), { ...attempt(), reply_id: "../escape" }], "invalid_record"],
    ["wrong session identity", [header({ session_id: parentId }), attempt()], "header"],
    ["duplicate record", [header(), attempt(), attempt()], "duplicate_record"],
    ["settlement without attempt", [header(), settlement()], "missing_attempt"],
    ["missing parent", [header(), attempt({ parent_reply_id: uuid(404) })], "context_parent"],
    ["self-parent", [header(), attempt({ parent_reply_id: replyId })], "context_parent"],
    [
      "wrong predecessor",
      [header(), attempt(), attempt({ reply_id: uuid(102) })],
      "attempt_predecessor",
    ],
    [
      "failed context parent",
      [
        header(),
        attempt(),
        failed(),
        attempt({ reply_id: uuid(102), exchange_id: uuid(202), parent_reply_id: replyId }),
      ],
      "context_parent",
    ],
    [
      "unsettled context parent",
      [
        header(),
        attempt(),
        attempt({ reply_id: uuid(102), exchange_id: uuid(202), parent_reply_id: replyId }),
      ],
      "context_parent",
    ],
    ["header alone", [header()], "empty_history"],
    [
      "inverted source range",
      [
        header(),
        attempt(),
        settlement({ sources: [{ ...settlement().sources[0], ranges: [{ start: 5, end: 2 }] }] }),
      ],
      "source_range",
    ],
    [
      "unknown generation field",
      [
        header(),
        attempt(),
        { ...settlement(), generation: { ...settlement().generation, made_up: true } },
      ],
      "invalid_record",
    ],
  ] as const)(
    "rejects %s rather than recovering a seemingly complete prefix",
    (_name, writes, reason) => {
      expect(failure(parseHistory(sessionId, historyBytes(writes)))).toMatchObject({
        _tag: "HistoryInvalid",
        reason,
      });
    },
  );

  it("rejects missing newlines, invalid UTF-8, blank lines and malformed middle lines", () => {
    const bytes = historyBytes([header(), attempt()]);
    const text = new TextDecoder().decode(bytes);
    for (const [input, reason] of [
      [bytes.slice(0, -1), "missing_newline"],
      [new Uint8Array([0xff, 0x0a]), "invalid_utf8"],
      [new TextEncoder().encode(text + "\n"), "blank_line"],
      [
        new TextEncoder().encode(text + "{\n" + JSON.stringify(settlement()) + "\n"),
        "invalid_json",
      ],
      [new Uint8Array(), "empty_history"],
    ] as const) {
      expect(failure(parseHistory(sessionId, input))).toMatchObject({ reason });
    }
  });

  it("rejects gaps in sequence numbers and misplaced headers", () => {
    const text = `${JSON.stringify({ ...header(), seq: 1 })}\n${JSON.stringify({ ...attempt(), seq: 3 })}\n`;
    expect(failure(parseHistory(sessionId, new TextEncoder().encode(text)))).toMatchObject({
      reason: "sequence",
      line: 2,
    });
    expect(failure(parseHistory(sessionId, historyBytes([attempt(), header()])))).toMatchObject({
      reason: "unsupported_format",
    });
  });

  it("preserves absent metadata without inventing execution claims", () => {
    const history = parse([
      header(),
      attempt({ accepted_at: null }),
      settlement({
        settled_at: null,
        context_messages: null,
        generation: null,
      }),
    ]);
    expect(history.turns[0].attempts[0].settlement?.generation).toBeNull();
    expect(history.turns[0].attempts[0].settlement?.context_messages).toBeNull();
    const stopped = parse([
      header(),
      attempt(),
      settlement({
        outcome: { status: "stopped" },
        answer: "",
        sources: [],
        context_messages: [],
        generation: null,
      }),
    ]);
    expect(stopped.turns[0].attempts[0].settlement?.context_messages).toEqual([]);
  });

  it("keeps historical question differences on their own attempts", () => {
    const history = parse([
      header(),
      attempt(),
      failed(),
      attempt({
        reply_id: uuid(102),
        previous_attempt_id: replyId,
        question: "A historical changed question",
      }),
    ]);
    expect(history.turns[0].attempts.map((value) => value.accepted.question)).toEqual([
      attempt().question,
      "A historical changed question",
    ]);
  });

  it("verifies the actual byte prefix named by a history receipt", () => {
    const first = parse([header(), attempt()]);
    const next = success(planHistoryAppend(sessionId, first, [settlement()])).history;
    expect(verifyHistoryReceipt(next, first.revision)._tag).toBe("Success");
    expect(verifyHistoryReceipt(next, next.revision)._tag).toBe("Success");
    expect(failure(verifyHistoryReceipt(first, next.revision))).toMatchObject({
      reason: "history_receipt",
    });
    expect(
      failure(
        verifyHistoryReceipt(next, {
          ...first.revision,
          sha256: Schema.decodeUnknownSync(FileFingerprint)("0".repeat(64)),
        }),
      ),
    ).toMatchObject({ reason: "history_receipt" });
  });

  it("preserves the namespaced prompt hash scheme instead of assuming raw text SHA-256", () => {
    const history = parse([header(), attempt(), settlement()]);
    const prepared = history.turns[0].attempts[0].settlement?.generation;
    expect(prepared).toMatchObject({
      system_prompt_hash: {
        scheme: "gm-prompt-v1",
        value: promptContentHash("Be concise. é 漢字"),
      },
    });
    expect(promptContentHash("Be concise. é 漢字")).not.toBe(sha256Hex("Be concise. é 漢字"));
  });
});

describe("conversation history append planning", () => {
  it("creates header and attempt as one validated write, with deterministic bytes", () => {
    const writes = [header(), attempt()];
    const first = success(planHistoryAppend(sessionId, null, writes));
    const again = success(planHistoryAppend(sessionId, null, writes));
    expect(first).toEqual(again);
    expect(first.changed).toBe(true);
    expect(failure(planHistoryAppend(sessionId, null, [header()]))).toMatchObject({
      reason: "empty_history",
    });
  });

  it("treats equal identity and content as a no-op, even with reordered object properties", () => {
    const history = parse([header(), attempt(), settlement()]);
    const { answer, ...rest } = settlement();
    const replay = success(
      planHistoryAppend(sessionId, history, [header(), attempt(), { answer, ...rest }]),
    );
    expect(replay).toEqual({ changed: false, history });
    expect(replay.history).toBe(history);
  });

  it.each([
    { ...settlement(), answer: "Conflicting answer" },
    { ...settlement(), outcome: { status: "stopped" } },
    { ...settlement(), settled_at: time("2026-10-10T13:00:00.000Z") },
    { ...attempt(), exchange_id: uuid(999) },
    { ...attempt(), question: "Conflicting accepted question" },
  ] as const)("rejects different content for an existing identity", (write) => {
    const history = parse([header(), attempt(), settlement()]);
    expect(failure(planHistoryAppend(sessionId, history, [write]))).toMatchObject({
      _tag: "HistoryConflict",
    });
    expect(history.turns[0].attempts[0].settlement?.answer).toBe(settlement().answer);
  });

  it("deduplicates an identical delivery inside one batch without consuming sequence numbers", () => {
    const result = success(
      planHistoryAppend(sessionId, null, [header(), attempt(), settlement(), settlement()]),
    );
    expect(result.history.revision.last_seq).toBe(3);
  });

  it("does not retain mutable input objects when planning a write", () => {
    const source = { ...settlement().sources[0] };
    const terminal = { ...settlement(), sources: [source] };
    const history = success(
      planHistoryAppend(sessionId, null, [header(), attempt(), terminal]),
    ).history;
    source.title = "Changed by caller";
    expect(history.turns[0].attempts[0].settlement?.sources[0].title).toBe("Original source title");
    expect(history.jsonl).not.toContain("Changed by caller");
  });
});

describe("history context dependencies", () => {
  const child = (id: SessionId, parent: SessionId) =>
    parse(
      [
        header({ session_id: id, context: { session_id: parent, reply_id: replyId } }),
        attempt(),
        settlement(),
      ],
      id,
    );

  it("reports absent context without discarding the child's own readable history", () => {
    const history = child(sessionId, parentId);
    expect(history.turns[0].attempts[0].settlement?.answer).toBe(settlement().answer);
    expect(inspectHistoryDependencies([history])).toEqual([
      { session_id: sessionId, dependency_id: parentId, reason: "missing_history" },
    ]);
  });

  it("finds inherited context cycles without recursive traversal", () => {
    const issues = inspectHistoryDependencies([
      child(sessionId, parentId),
      child(parentId, sessionId),
    ]);
    expect(issues.map((issue) => issue.reason)).toEqual(["context_cycle", "context_cycle"]);
  });

  it("does not confuse the annotated answer with a different fixed context cutoff", () => {
    const parent = parse(
      [
        header({ session_id: parentId }),
        attempt(),
        settlement(),
        attempt({ reply_id: uuid(102), exchange_id: uuid(202), parent_reply_id: replyId }),
        settlement({ reply_id: uuid(102) }),
      ],
      parentId,
    );
    const history = parse([
      header({
        origin: {
          kind: "answer",
          session_id: parentId,
          exchange_id: uuid(201),
          anchor: "same quote",
          paragraph: "same quote",
          paragraph_index: 0,
        },
        anchor_reply_id: replyId,
        context: { session_id: parentId, reply_id: uuid(102) },
      }),
      attempt({ reply_id: uuid(103) }),
      settlement({ reply_id: uuid(103) }),
    ]);
    expect(inspectHistoryDependencies([history, parent])).toEqual([]);
  });
});
