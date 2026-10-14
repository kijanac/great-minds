import { FileFingerprint } from "@great-minds/domain";
import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  acceptedRequestFor,
  type AcceptedReplyRequest,
} from "../src/conversation-history/admission.ts";
import {
  parseHistory,
  planHistoryAppend,
  verifyHistoryReceipt,
} from "../src/conversation-history/history.ts";
import { projectSession } from "../src/conversation-history/presentation.ts";
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
  timestamp,
  uuid,
} from "./fixtures/conversation-history.ts";

const success = <Value, Error>(result: Result.Result<Value, Error>): Value => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};
const failure = <Value, Error>(result: Result.Result<Value, Error>): Error => {
  if (Result.isSuccess(result)) throw new Error("Expected failure");
  return result.failure;
};
const parse = (writes: readonly object[]) => success(parseHistory(sessionId, historyBytes(writes)));
const failed = () =>
  settlement({ outcome: { status: "failed", code: "generation_failed", message: "Interrupted" } });

describe("native conversation history", () => {
  it.each(["completed", "stopped", "failed"] as const)(
    "preserves literal %s content, references and provenance",
    (status) => {
      const terminal = status === "failed" ? failed() : settlement({ outcome: { status } });
      const history = parse([header(), attempt(), terminal]);
      expect(history.turns[0].attempts[0].settlement).toMatchObject(terminal);
      expect(history.header.session_id).toBe(sessionId);
      expect(history.revision).toEqual({
        last_seq: 3,
        sha256: rawFileHash(historyBytes([header(), attempt(), terminal])),
      });
      expect(history.turns[0].attempts[0].settlement?.generation?.system_prompt_hash).toEqual({
        scheme: "gm-prompt-v1",
        value: promptContentHash("Be concise. é 漢字"),
      });
      expect(promptContentHash("Be concise. é 漢字")).not.toBe(sha256Hex("Be concise. é 漢字"));
    },
  );

  it("orders by acceptance and selects the latest attempt despite older timestamps and late settlements", () => {
    const retry = attempt({
      reply_id: uuid(103),
      previous_attempt_id: replyId,
      question: "A literal historical revision",
    });
    const history = parse([
      header(),
      attempt(),
      attempt({
        reply_id: uuid(102),
        exchange_id: uuid(202),
        accepted_at: time("2020-01-01T00:00:00.000Z"),
      }),
      settlement({ reply_id: uuid(102) }),
      retry,
      settlement({ reply_id: uuid(103) }),
      failed(),
    ]);
    expect(history.turns.map((turn) => turn.exchange_id)).toEqual([uuid(201), uuid(202)]);
    expect(projectSession(history)[1]).toMatchObject({
      reply_id: uuid(103),
      status: "completed",
      query: retry.question,
    });
    expect(
      history.turns[0].attempts.map(({ accepted, settlement }) => [
        accepted.question,
        settlement?.outcome.status,
      ]),
    ).toEqual([
      [attempt().question, "failed"],
      [retry.question, "completed"],
    ]);
  });

  it("distinguishes pending, empty completion, unknown metadata and known empty context", () => {
    expect(parse([header(), attempt()]).turns[0].attempts[0].settlement).toBeNull();
    const unknown = parse([
      header(),
      attempt({ accepted_at: null }),
      settlement({ answer: "", settled_at: null, context_messages: null, generation: null }),
    ]);
    expect(unknown.turns[0].attempts[0]).toMatchObject({
      accepted: { accepted_at: null },
      settlement: {
        answer: "",
        outcome: { status: "completed" },
        settled_at: null,
        context_messages: null,
        generation: null,
      },
    });
    expect(
      parse([header(), attempt(), settlement({ context_messages: [] })]).turns[0].attempts[0]
        .settlement?.context_messages,
    ).toEqual([]);
  });

  it.each([
    [[{ ...header(), version: 2 }, attempt()], "unsupported_format"],
    [[header(), attempt(), { type: "new-event" }], "invalid_record"],
    [
      [
        header(),
        attempt(),
        { ...settlement(), sources: [{ ...settlement().sources[0], pending: true }] },
      ],
      "invalid_record",
    ],
    [[header(), { ...attempt(), accepted_at: "2026-02-30T00:00:00.000Z" }], "invalid_record"],
    [[header(), { ...attempt(), reply_id: "../escape" }], "invalid_record"],
    [[header({ session_id: parentId }), attempt()], "header"],
    [[header(), attempt(), attempt()], "duplicate_record"],
    [[header(), settlement()], "missing_attempt"],
    [[header(), attempt({ parent_reply_id: uuid(404) })], "context_parent"],
    [[header(), attempt({ parent_reply_id: replyId })], "context_parent"],
    [[header(), attempt(), attempt({ reply_id: uuid(102) })], "attempt_predecessor"],
    [
      [
        header(),
        attempt(),
        failed(),
        attempt({ reply_id: uuid(102), exchange_id: uuid(202), parent_reply_id: replyId }),
      ],
      "context_parent",
    ],
    [
      [
        header(),
        attempt(),
        attempt({ reply_id: uuid(102), exchange_id: uuid(202), parent_reply_id: replyId }),
      ],
      "context_parent",
    ],
    [[header()], "empty_history"],
    [
      [
        header(),
        attempt(),
        settlement({ sources: [{ ...settlement().sources[0], ranges: [{ start: 5, end: 2 }] }] }),
      ],
      "source_range",
    ],
    [
      [
        header(),
        attempt(),
        { ...settlement(), generation: { ...settlement().generation, made_up: true } },
      ],
      "invalid_record",
    ],
  ] as const)("rejects malformed record case %# without prefix salvage", (writes, reason) => {
    expect(failure(parseHistory(sessionId, historyBytes(writes)))).toMatchObject({
      _tag: "HistoryInvalid",
      reason,
    });
  });

  it("rejects damaged framing, sequence gaps and misplaced headers", () => {
    const bytes = historyBytes([header(), attempt()]);
    const text = new TextDecoder().decode(bytes);
    const encode = (text: string) => new TextEncoder().encode(text);
    for (const [input, reason] of [
      [bytes.slice(0, -1), "missing_newline"],
      [new Uint8Array([0xff, 0x0a]), "invalid_utf8"],
      [encode(text + "\n"), "blank_line"],
      [encode(text + "{\n" + JSON.stringify(settlement()) + "\n"), "invalid_json"],
      [new Uint8Array(), "empty_history"],
      [
        encode(
          `${JSON.stringify({ ...header(), seq: 1 })}\n${JSON.stringify({ ...attempt(), seq: 3 })}\n`,
        ),
        "sequence",
      ],
      [historyBytes([attempt(), header()]), "unsupported_format"],
    ] as const) {
      const error = failure(parseHistory(sessionId, input));
      expect(error).toMatchObject({ reason });
      if (reason === "sequence") expect(error.line).toBe(2);
    }
  });

  it("verifies both current and older byte-prefix receipts", () => {
    const first = parse([header(), attempt()]);
    const next = success(planHistoryAppend(sessionId, first, [settlement()])).history;
    expect(failure(verifyHistoryReceipt(first, next.revision))).toMatchObject({
      reason: "history_receipt",
    });
    for (const revision of [first.revision, next.revision]) {
      expect(verifyHistoryReceipt(next, revision)._tag).toBe("Success");
      expect(
        failure(
          verifyHistoryReceipt(next, {
            ...revision,
            sha256: Schema.decodeUnknownSync(FileFingerprint)("0".repeat(64)),
          }),
        ),
      ).toMatchObject({ reason: "history_receipt" });
    }
  });

  it("plans atomic deterministic batches with detached inputs and semantic replay", () => {
    expect(failure(planHistoryAppend(sessionId, null, [header()]))).toMatchObject({
      reason: "empty_history",
    });
    const source = { ...settlement().sources[0] };
    const terminal = { ...settlement(), sources: [source] };
    const writes = [header(), attempt(), terminal, terminal];
    const first = success(planHistoryAppend(sessionId, null, writes));
    expect(first).toEqual(success(planHistoryAppend(sessionId, null, writes)));
    expect(first.changed).toBe(true);
    expect(first.history.revision.last_seq).toBe(3);
    source.title = "Changed by caller";
    expect(first.history.turns[0].attempts[0].settlement?.sources[0].title).toBe(
      "Original source title",
    );
    expect(first.history.jsonl).not.toContain("Changed by caller");
    const { answer, ...rest } = settlement();
    const replay = success(
      planHistoryAppend(sessionId, first.history, [header(), attempt(), { answer, ...rest }]),
    );
    expect(replay.changed).toBe(false);
    expect(replay.history).toBe(first.history);
  });

  it.each([
    { ...settlement(), answer: "Conflicting answer" },
    { ...settlement(), outcome: { status: "stopped" } },
    { ...settlement(), settled_at: time("2026-10-10T13:00:00.000Z") },
    { ...attempt(), exchange_id: uuid(999) },
    { ...attempt(), question: "Conflicting accepted question" },
  ] as const)("rejects changed content for an existing identity", (write) => {
    const history = parse([header(), attempt(), settlement()]);
    expect(failure(planHistoryAppend(sessionId, history, [write]))).toMatchObject({
      _tag: "HistoryConflict",
    });
    expect(history.turns[0].attempts[0].settlement?.answer).toBe(settlement().answer);
  });

  it("parses accepted descriptors and rejects malformed or mismatched frozen identity without database setup", async () => {
    const request = {
      version: 1,
      mode: "query",
      header: header(),
      attempt: { ...attempt(), accepted_at: timestamp },
      command: {
        reply_id: replyId,
        exchange_id: uuid(201),
        question: attempt().question,
        origin_scope: "vault",
        session: {
          kind: "new",
          idempotency_key: "descriptor",
          conversation_kind: "session",
          origin_scope: "vault",
        },
      },
    } satisfies AcceptedReplyRequest;
    const row = { id: replyId, userId: request.header.author_id, sessionId, request };
    expect(await Effect.runPromise(acceptedRequestFor(row))).toEqual(request);
    for (const invalid of [
      { ...request, version: 2 },
      { ...request, extra: true },
      { ...request, mode: null },
      { ...request, attempt: { ...request.attempt, accepted_at: null } },
    ])
      expect(
        failure(
          await Effect.runPromise(Effect.result(acceptedRequestFor({ ...row, request: invalid }))),
        ),
      ).toMatchObject({ reason: "request_payload" });
    for (const invalid of [
      { ...request, header: { ...request.header, author_id: uuid(99) } },
      {
        ...request,
        header: {
          ...request.header,
          origin: {
            kind: "document",
            doc_path: "wiki/other.md",
            origin_scope: "vault",
            anchor: "changed",
            paragraph: "changed",
            paragraph_index: 0,
          },
        },
      },
      { ...request, attempt: { ...request.attempt, parent_reply_id: uuid(99) } },
      { ...request, attempt: { ...request.attempt, previous_attempt_id: uuid(99) } },
    ])
      expect(
        failure(
          await Effect.runPromise(Effect.result(acceptedRequestFor({ ...row, request: invalid }))),
        ),
      ).toMatchObject({ reason: "request_identity" });
  });
});
