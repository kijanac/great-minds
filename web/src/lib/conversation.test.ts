import {
  CreateReplyRequest,
  SessionId,
  Uuid,
  type OriginSessionDetail,
  type SessionOrigin,
  type SessionExchangeEvent,
  type SessionResponse,
} from "@great-minds/domain";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createReply,
  retryReply,
  stopReply,
  streamReply,
  type ReplySnapshot,
} from "#lib/api/replies.ts";
import { Conversation, type ConversationOptions } from "#lib/conversation.svelte.ts";

vi.mock("$app/env", () => ({ browser: true }));
vi.mock("#lib/api/replies.ts", () => ({
  createReply: vi.fn(),
  retryReply: vi.fn(),
  stopReply: vi.fn(),
  streamReply: vi.fn(),
}));

const sessionId = SessionId.make("00000000-0000-4000-8000-000000000001");
const replyId = Uuid.make("00000000-0000-4000-8000-000000000002");
const nextReplyId = Uuid.make("00000000-0000-4000-8000-000000000003");
const exchangeId = Uuid.make("00000000-0000-4000-8000-000000000004");
const now = new Date("2026-09-17T12:00:00Z");
const passage = {
  anchor: "quote",
  paragraph: "A quote in context.",
  paragraph_index: 10,
};
const origins: SessionOrigin[] = [
  {
    kind: "document",
    doc_path: "wiki/test.md",
    origin_scope: "vault",
    ...passage,
  },
  {
    kind: "document",
    doc_path: "raw/test.md",
    origin_scope: "personal",
    ...passage,
  },
  {
    kind: "answer",
    session_id: sessionId,
    exchange_id: exchangeId,
    ...passage,
  },
];
type Available = Extract<OriginSessionDetail, { availability: "available" }>;
const saved = (
  origin: SessionOrigin,
  status: SessionExchangeEvent["status"] = "running",
  answer = "",
): Available => ({
  availability: "available",
  activity: status === "running" ? { reply_id: replyId, status } : null,
  session: {
    id: sessionId,
    kind: "btw",
    query: "Canonical question",
    created_at: now,
    updated_at: now,
    user_id: exchangeId,
    origin,
    origin_title: null,
  },
  events: [
    {
      type: "exchange",
      exId: exchangeId,
      reply_id: replyId,
      version: status === "running" ? 0 : null,
      query: "Replayed question",
      status,
      error: status === "failed" ? "Saved failure" : null,
      thinking: [],
      answer,
      citations: [],
      ts: now,
    },
  ],
});
const sessionData = (
  detail: Available,
  overrides: Partial<SessionResponse> = {},
): SessionResponse => ({
  id: detail.session.id,
  kind: "session",
  origin_title: null,
  threads: [],
  activity: detail.activity,
  events: detail.events,
  ...overrides,
});
let nextVersion = 0;
const snapshot = (
  answer: string,
  status: ReplySnapshot["status"] = "completed",
  id = replyId,
  version = ++nextVersion,
): ReplySnapshot => ({
  reply_id: id,
  session_id: sessionId,
  status,
  answer,
  citations: [],
  sources: [],
  error: null,
  version,
  created_at: now,
  updated_at: now,
});
const threads: Conversation[] = [];
const make = (options?: ConversationOptions) => {
  const thread = new Conversation(options);
  threads.push(thread);
  return thread;
};

beforeEach(() => {
  vi.resetAllMocks();
  nextVersion = 0;
  vi.mocked(createReply).mockImplementation(async (payload) => {
    Schema.encodeSync(CreateReplyRequest)(payload);
    return { session_id: sessionId, reply_id: payload.reply_id };
  });
  vi.mocked(retryReply).mockResolvedValue({
    session_id: sessionId,
    reply_id: nextReplyId,
  });
  vi.mocked(streamReply).mockImplementation(async function* (id) {
    yield snapshot("Completed answer", "completed", id);
  });
});
afterEach(() => {
  for (const thread of threads.splice(0)) thread.destroy();
});

it.each(origins)(
  "replays unacknowledged inline creation with $kind origin and original IDs, then follows up",
  async (origin) => {
    vi.mocked(createReply).mockRejectedValueOnce(new Error("connection lost"));
    const btw = make({ origin });
    expect(await btw.ask("First question", true)).toBe(false);
    expect(btw.submission.status).toBe("failed");
    expect(btw.exchanges).toEqual([]);
    const first = vi.mocked(createReply).mock.calls[0][0];
    expect(first).toMatchObject({
      inline: true,
      session: { kind: "new", conversation_kind: "btw", origin },
    });
    expect(first.origin_scope).toBe(origin.kind === "document" ? origin.origin_scope : "vault");
    expect(await btw.ask("First question", true)).toBe(true);
    await vi.waitFor(() => expect(btw.exchanges[0].answer).toBe("Completed answer"));
    expect(vi.mocked(createReply).mock.calls[1][0]).toEqual(first);
    expect(btw.sessionId).toBe(sessionId);
    expect(btw.draft).toBe(false);
    await btw.ask("Follow-up question");
    await vi.waitFor(() => expect(btw.exchanges[1].answer).toBe("Completed answer"));
    expect(vi.mocked(createReply).mock.calls[2][0]).toMatchObject({
      inline: false,
      session: { kind: "existing", id: sessionId },
    });
    expect(btw.anchor.quote).toBe(origin.anchor);
    expect(btw.title).toBe("First question");
  },
);

it("reconnects observation before allowing a confirmed failure to create a new generation", async () => {
  vi.mocked(streamReply).mockImplementationOnce(async function* () {
    yield snapshot("Partial answer", "running");
    throw new Error("connection lost");
  });
  const btw = make({ detail: saved(origins[0]) });
  await vi.waitFor(() => expect(btw.connectionError).toBeTruthy());
  expect(await btw.ask("Do not replace")).toBe(false);
  btw.retry(exchangeId);
  expect(createReply).not.toHaveBeenCalled();
  expect(retryReply).not.toHaveBeenCalled();
  expect(streamReply).toHaveBeenCalledWith(replyId, expect.any(AbortSignal));
  vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
    yield {
      ...snapshot("Partial answer", "failed", id),
      error: "Saved failure",
    };
  });
  btw.reconnect();
  await vi.waitFor(() => expect(btw.exchanges[0].status).toBe("failed"));
  expect(retryReply).not.toHaveBeenCalled();
  vi.mocked(retryReply).mockRejectedValueOnce(new Error("offline"));
  btw.retry(exchangeId);
  await vi.waitFor(() => expect(btw.exchanges[0].status).toBe("failed"));
  expect(btw.exchanges[0]).toMatchObject({ answer: "Partial answer", replyId });
  vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
    yield snapshot("New partial answer", "running", id);
    throw new Error("connection lost again");
  });
  btw.retry(exchangeId);
  await vi.waitFor(() => expect(btw.connectionError).toBeTruthy());
  expect(btw.exchanges[0]).toMatchObject({
    answer: "New partial answer",
    replyId: nextReplyId,
    status: "running",
  });
  expect(btw.title).toBe("Canonical question");
});

it("aborts only the disposed conversation and leaves another streaming", async () => {
  const finish = Promise.withResolvers<void>();
  vi.mocked(streamReply).mockImplementation(async function* () {
    yield snapshot("Streaming", "running");
    await finish.promise;
    yield snapshot("Finished");
  });
  const first = make({ detail: saved(origins[0]) });
  const second = make({ detail: saved(origins[2]) });
  await vi.waitFor(() => expect(streamReply).toHaveBeenCalledTimes(2));
  first.destroy();
  expect(vi.mocked(streamReply).mock.calls[0][1]?.aborted).toBe(true);
  expect(vi.mocked(streamReply).mock.calls[1][1]?.aborted).toBe(false);
  finish.resolve();
  await vi.waitFor(() => expect(second.exchanges[0].answer).toBe("Finished"));
});

it("hydrates saved origin and attached BTW without resubmitting either conversation", async () => {
  const detail = saved(origins[2]);
  const childId = SessionId.make("saved-child");
  vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
    yield {
      ...snapshot("Completed answer", "completed", id),
      session_id: childId,
    };
  });
  const session = make({
    saved: sessionData(saved(origins[0], "completed", "Parent answer"), {
      origin_title: "Original document",
      threads: [{ ...detail, session: { ...detail.session, id: childId } }],
      events: [
        {
          type: "meta",
          id: sessionId,
          query: "Parent question",
          ts: now,
          user_id: exchangeId,
          origin: origins[0],
        },
        ...saved(origins[0], "completed", "Parent answer").events,
      ],
    }),
    initialQuery: "Do not resubmit",
    origin: origins[1],
  });
  await vi.waitFor(() =>
    expect(session.exchanges[0].btws[0].exchanges[0].answer).toBe("Completed answer"),
  );
  expect(createReply).not.toHaveBeenCalled();
  expect(session.origin).toEqual(origins[0]);
  expect(session.originTitle).toBe("Original document");
  expect(session.exchanges[0].answer).toBe("Parent answer");
  expect(session.exchanges[0].btws[0].sessionId).toBe(childId);
});

it.each([undefined, "wiki/test.md"])(
  "creates and follows up a conversation with origin %s without duplicating its creation callback",
  async (originPath) => {
    const onCreated = vi.fn();
    const origin =
      originPath === undefined
        ? null
        : ({
            kind: "document",
            doc_path: originPath,
            origin_scope: "vault",
            anchor: null,
            paragraph: null,
            paragraph_index: null,
          } as const);
    const session = make({
      origin,
      onCreated,
      initialQuery: originPath === undefined ? undefined : "Start here",
    });
    if (originPath === undefined) void session.ask("Start here");
    await vi.waitFor(() => expect(session.exchanges[0]?.answer).toBe("Completed answer"));
    const first = vi.mocked(createReply).mock.calls[0][0];
    expect(first).not.toHaveProperty("mode");
    expect(first).toMatchObject({
      inline: false,
      session: { kind: "new", conversation_kind: "session" },
    });
    if (originPath === undefined) expect(first).not.toHaveProperty("origin_path");
    else expect(first).toMatchObject({ origin_path: originPath, session: { origin } });
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(sessionId);
    await session.ask("Follow up");
    await vi.waitFor(() => expect(session.exchanges[1]?.answer).toBe("Completed answer"));
    expect(vi.mocked(createReply).mock.calls[1][0].session).toEqual({
      kind: "existing",
      id: sessionId,
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
  },
);

it.each(["stopped", "completed"] as const)(
  "retains failed Stop as retryable, waits for %s confirmation and unlocks follow-up",
  async (status) => {
    const terminal = Promise.withResolvers<void>();
    vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
      yield snapshot("Partial answer", "running", id);
      await terminal.promise;
      yield snapshot("Partial answer", status, id);
    });
    vi.mocked(stopReply).mockRejectedValueOnce(new Error("offline"));
    const session = make();
    void session.ask("Question");
    expect(session.canStop).toBe(false);
    await vi.waitFor(() => expect(session.canStop).toBe(true));
    await session.stop();
    expect(session.stopFailed).toBe(true);
    expect(session.canStop).toBe(true);
    if (status === "stopped") {
      await Promise.all([session.stop(), session.stop()]);
      expect(stopReply).toHaveBeenCalledTimes(2);
      expect(stopReply).toHaveBeenLastCalledWith(
        session.exchanges[0].replyId,
        expect.any(AbortSignal),
      );
      expect(session.stopping).toBe(true);
    }
    expect(session.phase).toBe("streaming");
    expect(session.exchanges[0].answer).toBe("Partial answer");
    terminal.resolve();
    await vi.waitFor(() => expect(session.phase).toBe("done"));
    expect(session.stopping).toBe(false);
    expect(session.stopFailed).toBe(false);
    expect(session.canStop).toBe(false);
    expect(session.exchanges[0]).toMatchObject({
      status,
      answer: "Partial answer",
      error: null,
    });
    await session.ask("Continue");
    await vi.waitFor(() => expect(session.exchanges[1]?.answer).toBe("Completed answer"));
  },
);

it.each([
  ["stopped", ""],
  ["stopped", "Partial answer"],
  ["completed", ""],
  ["failed", ""],
  ["failed", "Private partial answer"],
] as const)("hydrates %s with %j without regenerating", async (status, answer) => {
  const detail = saved(origins[0], status, answer);
  const views = [make({ detail }), make({ saved: sessionData(detail) })];
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const view of views) {
    expect(view.exchanges[0]).toMatchObject({
      answer,
      status,
      error: status === "failed" ? "Saved failure" : null,
    });
    expect(view.phase).toBe("done");
  }
  expect(streamReply).not.toHaveBeenCalled();
  expect(createReply).not.toHaveBeenCalled();
});

it("keeps a reply finalizing and preserves recorded content until terminal confirmation", async () => {
  const observed = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const detail = saved(origins[0], "completed", "Recorded answer");
  vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
    yield snapshot("Stale running partial", "running", id, 6);
    observed.resolve();
    await finish.promise;
    yield snapshot("Stale terminal cache", "completed", id, 7);
  });
  const view = make({
    detail: {
      ...detail,
      activity: { reply_id: replyId, status: "settling" },
      events: detail.events.map((event) =>
        event.type === "exchange" ? { ...event, version: 5 } : event,
      ),
    },
  });
  await observed.promise;
  expect(view.exchanges[0]).toMatchObject({
    answer: "Recorded answer",
    status: "completed",
    version: 6,
  });
  expect(view.phase).toBe("finalizing");
  expect(view.canStop).toBe(false);
  expect(await view.ask("Must wait")).toBe(false);
  expect(createReply).not.toHaveBeenCalled();
  expect(retryReply).not.toHaveBeenCalled();
  finish.resolve();
  await vi.waitFor(() => expect(view.activity).toBeNull());
  expect(view.exchanges[0].answer).toBe("Recorded answer");
});

it("rejects stale/wrong-identity snapshots and reconnects the earlier active turn without generating", async () => {
  const detail = saved(origins[0], "running", "Hydrated partial");
  const event = detail.events[0];
  if (event.type !== "exchange") throw new Error("Expected exchange");
  vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
    yield snapshot("Older partial", "running", id, 4);
    yield snapshot("Wrong attempt", "running", nextReplyId, 999);
    throw new Error("Disconnected");
  });
  vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
    yield snapshot("Completed answer", "completed", id, 6);
  });
  const view = make({
    detail: {
      ...detail,
      events: [
        { ...event, version: 5 },
        {
          ...event,
          exId: Uuid.make("00000000-0000-4000-8000-000000000005"),
          reply_id: nextReplyId,
          status: "completed",
          answer: "Later exchange",
          version: null,
        },
      ],
    },
  });
  await vi.waitFor(() => expect(view.connectionError).toBeTruthy());
  expect(view.exchanges[0]).toMatchObject({
    answer: "Hydrated partial",
    version: 5,
  });
  expect(view.phase).toBe("streaming");
  expect(await view.ask("Must wait")).toBe(false);
  view.retry(exchangeId);
  expect(retryReply).not.toHaveBeenCalled();
  view.reconnect();
  await vi.waitFor(() => expect(view.activity).toBeNull());
  expect(view.connectionError).toBeNull();
  expect(vi.mocked(streamReply).mock.calls.map(([id]) => id)).toEqual([replyId, replyId]);
  expect(view.exchanges.map((turn) => turn.answer)).toEqual(["Completed answer", "Later exchange"]);
  expect(createReply).not.toHaveBeenCalled();
  expect(retryReply).not.toHaveBeenCalled();
});

it("allows Stop again when reconnect cancels an unconfirmed Stop request", async () => {
  const resumed = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
    yield snapshot("Partial", "running", id);
    throw new Error("Disconnected");
  });
  vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
    yield snapshot("Partial", "running", id);
    resumed.resolve();
    await finish.promise;
    yield snapshot("Saved", "stopped", id);
  });
  vi.mocked(stopReply).mockImplementationOnce(
    (_id, signal) =>
      new Promise<void>((_resolve, reject) => {
        if (!signal) throw new Error("Expected Stop signal");
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      }),
  );
  const view = make({ saved: sessionData(saved(origins[0])) });
  await vi.waitFor(() => expect(view.connectionError).toBeTruthy());
  const stopping = view.stop();
  expect(view.stopping).toBe(true);
  view.reconnect();
  await resumed.promise;
  await stopping;
  expect(view.canStop).toBe(true);
  expect(createReply).not.toHaveBeenCalled();
  expect(retryReply).not.toHaveBeenCalled();
  finish.resolve();
  await vi.waitFor(() => expect(view.activity).toBeNull());
});

describe("retry acknowledgment", () => {
  it.each(["completed", "failed"] as const)(
    "redelivers the accepted identity after the replacement has %s",
    async (outcome) => {
      const accepted = new Map<Uuid, Uuid>();
      let loseAcknowledgment = true;
      vi.mocked(retryReply).mockImplementation(async (previousId, nextId) => {
        const existing = accepted.get(previousId);
        if (existing !== undefined && existing !== nextId)
          throw new Error("Retry already accepted");
        accepted.set(previousId, nextId);
        if (loseAcknowledgment) {
          loseAcknowledgment = false;
          throw new Error("Acknowledgment lost");
        }
        return { session_id: sessionId, reply_id: nextId };
      });
      vi.mocked(streamReply).mockImplementation(async function* (id) {
        yield {
          ...snapshot("Recorded retry", outcome, id),
          error: outcome === "failed" ? "Saved failure" : null,
        };
      });
      const view = make({ detail: saved(origins[0], "failed", "Original partial") });
      const retry = () => view.retry(exchangeId);
      retry();
      await vi.waitFor(() => expect(view.exchanges[0].status).toBe("failed"));
      expect(view.exchanges[0]).toMatchObject({
        replyId,
        answer: "Original partial",
      });
      expect(streamReply).not.toHaveBeenCalled();
      retry();
      expect(vi.mocked(retryReply).mock.calls[1].slice(0, 2)).toEqual(
        vi.mocked(retryReply).mock.calls[0].slice(0, 2),
      );
      await vi.waitFor(() => expect(view.exchanges[0].answer).toBe("Recorded retry"));
      expect(view.exchanges[0].status).toBe(outcome);
      expect(view.exchanges[0].replyId).toBe(accepted.get(replyId));
      expect(accepted.size).toBe(1);
      expect(createReply).not.toHaveBeenCalled();
      if (outcome === "failed") {
        retry();
        await vi.waitFor(() => expect(view.exchanges[0].status).toBe("failed"));
        const [previousId, nextId] = vi.mocked(retryReply).mock.calls[2];
        expect(previousId).toBe(accepted.get(replyId));
        expect(nextId).not.toBe(previousId);
        expect(accepted.size).toBe(2);
      }
    },
  );
});

it("keeps an unavailable saved note noneditable, nondismissible and distinct from an empty draft", async () => {
  const parent = saved(origins[0], "completed", "Parent answer");
  const child = saved(origins[2], "completed");
  const childId = SessionId.make("saved-child");
  const view = make({
    saved: sessionData(parent, {
      threads: [
        {
          availability: "unavailable",
          detail: "History unavailable",
          session: { ...child.session, id: childId },
        },
      ],
    }),
  });
  const note = view.exchanges[0].btws[0];
  await Promise.resolve();
  expect(note.sessionId).toBe(childId);
  expect(note.unavailable).toBeTruthy();
  expect(note.draft).toBe(false);
  expect(note.canAsk).toBe(false);
  expect(await note.ask("Do not replace missing history")).toBe(false);
  view.dismissBtw(note.id);
  expect(view.exchanges[0].btws).toHaveLength(1);
  expect(streamReply).not.toHaveBeenCalled();
  expect(createReply).not.toHaveBeenCalled();
});
