import {
  CreateReplyRequest,
  SessionId,
  Uuid,
  type OriginSessionDetail,
  type SessionOrigin,
  type SessionExchangeEvent,
} from "@great-minds/domain";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createReply,
  retryReply,
  stopReply,
  streamReply,
  type ReplySnapshot,
} from "$lib/api/replies";
import { continueAsSession } from "$lib/api/sessions";
import { Btw } from "$lib/btw.svelte";
import { queryClient } from "$lib/query-client";
import { Session } from "$lib/session.svelte";

vi.mock("$app/environment", () => ({ browser: true }));
vi.mock("$lib/api/replies", () => ({
  createReply: vi.fn(),
  retryReply: vi.fn(),
  stopReply: vi.fn(),
  streamReply: vi.fn(),
}));
vi.mock("$lib/api/sessions", () => ({ continueAsSession: vi.fn() }));
vi.mock("$lib/api/selected-vault", () => ({ selectedVault: () => "vault" }));
vi.mock("$lib/query-client", () => ({ queryClient: { invalidateQueries: vi.fn() } }));

const sessionId = SessionId.make("00000000-0000-4000-8000-000000000001");
const replyId = Uuid.make("00000000-0000-4000-8000-000000000002");
const nextReplyId = Uuid.make("00000000-0000-4000-8000-000000000003");
const exchangeId = Uuid.make("00000000-0000-4000-8000-000000000004");
const now = new Date("2026-09-17T12:00:00Z");
const origins: SessionOrigin[] = [
  {
    kind: "document",
    doc_path: "wiki/test.md",
    origin_scope: "vault",
    anchor: "quote",
    paragraph: "A quote in context.",
    paragraph_index: 10,
  },
  {
    kind: "document",
    doc_path: "raw/test.md",
    origin_scope: "personal",
    anchor: "quote",
    paragraph: "A quote in context.",
    paragraph_index: 10,
  },
  {
    kind: "answer",
    session_id: sessionId,
    exchange_id: exchangeId,
    anchor: "quote",
    paragraph: "A quote in context.",
    paragraph_index: 10,
  },
];

const saved = (
  origin: SessionOrigin,
  status: SessionExchangeEvent["status"] = "running",
  answer = "",
): Extract<OriginSessionDetail, { availability: "available" }> => ({
  availability: "available",
  activity: status === "running" ? { reply_id: replyId, status: "running" } : null,
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
      ts: now,
    },
  ],
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
  kind: "exchange",
  status,
  answer,
  sources: [],
  error: null,
  version,
  created_at: now,
  updated_at: now,
});

const threads: (Btw | Session)[] = [];
const makeBtw = (origin: SessionOrigin, detail?: OriginSessionDetail, onOpen = vi.fn()) => {
  const thread = new Btw(origin, onOpen, detail);
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
  vi.mocked(retryReply).mockResolvedValue({ session_id: sessionId, reply_id: nextReplyId });
  vi.mocked(streamReply).mockImplementation(async function* (id) {
    yield snapshot("Completed answer", "completed", id);
  });
});

afterEach(() => {
  for (const thread of threads.splice(0)) thread.destroy();
});

describe.each(origins)("BTW from $kind", (origin) => {
  it("retries an unacknowledged creation with its original quote and request IDs, then follows up in the same session", async () => {
    vi.mocked(createReply).mockRejectedValueOnce(new Error("connection lost"));
    const btw = makeBtw(origin);
    btw.reply("First question");
    await vi.waitFor(() => expect(btw.exchanges[0].error).toBeTruthy());
    const first = vi.mocked(createReply).mock.calls[0][0];
    expect(first.session).toMatchObject({ kind: "new", conversation_kind: "btw", origin });
    expect(first.origin_scope).toBe(origin.kind === "document" ? origin.origin_scope : "vault");

    btw.retry(btw.exchanges[0].id);
    await vi.waitFor(() => expect(btw.exchanges[0].answer).toBe("Completed answer"));
    expect(vi.mocked(createReply).mock.calls[1][0]).toEqual(first);
    expect(btw.conversation).toEqual({ id: sessionId, kind: "btw", query: "First question" });
    expect(btw.draft).toBe(false);

    btw.reply("Follow-up question");
    await vi.waitFor(() => expect(btw.exchanges[1].answer).toBe("Completed answer"));
    expect(vi.mocked(createReply).mock.calls[2][0].session).toEqual({
      kind: "existing",
      id: sessionId,
    });
    expect(btw.anchor.quote).toBe(origin.anchor);
    expect(btw.conversation?.query).toBe("First question");
  });

  it("reconnects an interrupted stream without retrying generation, then permits retry after confirmed failure", async () => {
    vi.mocked(streamReply).mockImplementationOnce(async function* () {
      yield snapshot("Partial answer", "running");
      throw new Error("connection lost");
    });
    const btw = makeBtw(origin, saved(origin));
    await vi.waitFor(() => expect(btw.connectionError).toBeTruthy());
    expect(createReply).not.toHaveBeenCalled();
    expect(streamReply).toHaveBeenCalledWith(replyId, expect.any(AbortSignal));
    btw.reply("Do not create a replacement");
    expect(createReply).not.toHaveBeenCalled();
    vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
      yield { ...snapshot("Partial answer", "failed", id), error: "Saved failure" };
    });
    btw.retry(exchangeId);
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
    expect(btw.conversation?.query).toBe("Canonical question");
  });
});

it("continues once, retains the canonical title with an empty completed answer, and becomes a link", async () => {
  const detail = saved(origins[0], "completed");
  const onOpen = vi.fn();
  const btw = makeBtw(origins[0], detail, onOpen);
  const promotion = Promise.withResolvers<void>();
  vi.mocked(continueAsSession).mockReturnValue(promotion.promise);
  const pending = btw.openSession();
  btw.reply("Blocked during promotion");
  await btw.openSession();
  expect(continueAsSession).toHaveBeenCalledTimes(1);
  expect(createReply).not.toHaveBeenCalled();
  promotion.resolve();
  await pending;
  expect(btw.conversation).toMatchObject({
    id: sessionId,
    kind: "session",
    query: "Canonical question",
  });
  expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
    queryKey: ["vault", "vault", "sessions"],
  });
  expect(onOpen).toHaveBeenCalledWith(sessionId);
  btw.reply("Blocked after promotion");
  await btw.openSession();
  expect(createReply).not.toHaveBeenCalled();
  expect(continueAsSession).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledTimes(2);
});

it("keeps a failed promotion editable and ignores navigation after its owner is destroyed", async () => {
  const onOpen = vi.fn();
  const btw = makeBtw(origins[0], saved(origins[0], "completed", "Answer"), onOpen);
  vi.mocked(continueAsSession).mockRejectedValueOnce(new Error("offline"));
  await btw.openSession();
  expect(btw.conversation?.kind).toBe("btw");
  expect(btw.promoting).toBe(false);
  expect(btw.error).toBeTruthy();

  const promotion = Promise.withResolvers<void>();
  vi.mocked(continueAsSession).mockReturnValueOnce(promotion.promise);
  const pending = btw.openSession();
  btw.destroy();
  promotion.resolve();
  await pending;
  expect(onOpen).not.toHaveBeenCalled();
});

it("aborts only the disposed thread and keeps another thread streaming", async () => {
  const finish = Promise.withResolvers<void>();
  vi.mocked(streamReply).mockImplementation(async function* () {
    yield snapshot("Still streaming", "running");
    await finish.promise;
    yield snapshot("Finished");
  });
  const first = makeBtw(origins[0], saved(origins[0]));
  const second = makeBtw(origins[2], saved(origins[2]));
  await vi.waitFor(() => expect(streamReply).toHaveBeenCalledTimes(2));
  await first.openSession();
  expect(continueAsSession).not.toHaveBeenCalled();
  first.destroy();
  expect(vi.mocked(streamReply).mock.calls[0][1]?.aborted).toBe(true);
  expect(vi.mocked(streamReply).mock.calls[1][1]?.aborted).toBe(false);
  finish.resolve();
  await vi.waitFor(() => expect(second.exchanges[0].answer).toBe("Finished"));
});

it("opens a saved session with its origin and reconnects an attached BTW without resubmitting", async () => {
  const detail = saved(origins[2]);
  const childId = SessionId.make("00000000-0000-4000-8000-000000000005");
  vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
    yield { ...snapshot("Completed answer", "completed", id), session_id: childId };
  });
  const session = new Session({
    saved: {
      id: sessionId,
      kind: "session",
      origin_title: "Original document",
      activity: null,
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
      threads: [{ ...detail, session: { ...detail.session, id: childId } }],
    },
    initialQuery: "Do not resubmit",
    originPath: "wiki/not-the-origin.md",
  });
  threads.push(session);
  await vi.waitFor(() =>
    expect(session.thread[0].btws[0].exchanges[0].answer).toBe("Completed answer"),
  );
  expect(createReply).not.toHaveBeenCalled();
  expect(session.origin).toEqual(origins[0]);
  expect(session.originTitle).toBe("Original document");
  expect(session.thread[0].answer).toBe("Parent answer");
  expect(session.thread[0].btws[0].conversation?.id).toBe(childId);
});

it("encodes an ordinary session's first question and follow-up without an origin path", async () => {
  const session = new Session();
  threads.push(session);
  session.submitQuery("Start here");
  await vi.waitFor(() => expect(session.thread[0]?.answer).toBe("Completed answer"));
  expect(vi.mocked(createReply).mock.calls[0][0]).not.toHaveProperty("origin_path");
  expect(vi.mocked(createReply).mock.calls[0][0]).not.toHaveProperty("mode");
  session.submitQuery("Follow up");
  await vi.waitFor(() => expect(session.thread[1]?.answer).toBe("Completed answer"));
  expect(vi.mocked(createReply).mock.calls[1][0].session).toEqual({
    kind: "existing",
    id: sessionId,
  });
});

it("waits for Stop confirmation, retains the partial answer, and permits another follow-up", async () => {
  const terminal = Promise.withResolvers<void>();
  vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
    yield snapshot("Partial answer", "running", id);
    await terminal.promise;
    yield snapshot("Partial answer", "stopped", id);
  });
  const session = new Session();
  threads.push(session);
  session.submitQuery("A long answer");
  expect(session.canStop).toBe(false);
  await vi.waitFor(() => expect(session.canStop).toBe(true));
  const activeReply = session.thread[0].replyId;
  await Promise.all([session.stop(), session.stop()]);
  expect(stopReply).toHaveBeenCalledExactlyOnceWith(activeReply, expect.any(AbortSignal));
  expect(session.stopping).toBe(true);
  expect(session.phase).toBe("streaming");
  expect(session.thread[0].answer).toBe("Partial answer");
  terminal.resolve();
  await vi.waitFor(() => expect(session.phase).toBe("done"));
  expect(session.stopping).toBe(false);
  expect(session.thread[0]).toMatchObject({
    status: "stopped",
    answer: "Partial answer",
    error: null,
  });
  session.followUpDraft = "Continue";
  session.submitFollowUp();
  await vi.waitFor(() => expect(session.thread[1]?.answer).toBe("Completed answer"));
});

it("keeps a failed stop retryable while the answer continues streaming", async () => {
  const terminal = Promise.withResolvers<void>();
  vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
    yield snapshot("Partial answer", "running", id);
    await terminal.promise;
    yield snapshot("Finished answer", "completed", id);
  });
  vi.mocked(stopReply).mockRejectedValueOnce(new Error("offline"));
  const session = new Session();
  threads.push(session);
  session.submitQuery("Question");
  await vi.waitFor(() => expect(session.canStop).toBe(true));
  await session.stop();
  expect(session.stopFailed).toBe(true);
  expect(session.canStop).toBe(true);
  expect(session.phase).toBe("streaming");
  terminal.resolve();
  await vi.waitFor(() => expect(session.phase).toBe("done"));
  expect(session.stopFailed).toBe(false);
  expect(session.canStop).toBe(false);
});

it.each(["", "Partial answer"])(
  "reloads a deliberately stopped session with %j without resuming or resubmitting it",
  async (answer) => {
    const session = new Session({
      saved: {
        id: sessionId,
        kind: "session",
        origin_title: null,
        threads: [],
        activity: null,
        events: [
          {
            type: "exchange",
            exId: exchangeId,
            reply_id: replyId,
            version: null,
            query: "Question",
            answer,
            thinking: [],
            status: "stopped",
            error: null,
            ts: now,
          },
        ],
      },
    });
    threads.push(session);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.phase).toBe("done");
    expect(session.thread[0]).toMatchObject({ status: "stopped", answer });
    expect(streamReply).not.toHaveBeenCalled();
    expect(createReply).not.toHaveBeenCalled();
  },
);

it.each([
  ["completed", ""],
  ["failed", ""],
  ["failed", "Private partial answer"],
] as const)("reloads %s with %j without silently regenerating it", async (status, answer) => {
  const detail = saved(origins[0], status, answer);
  const btw = makeBtw(origins[0], detail);
  const session = new Session({
    saved: {
      id: sessionId,
      kind: "session",
      origin_title: null,
      threads: [],
      activity: detail.activity,
      events: detail.events,
    },
  });
  threads.push(session);
  await Promise.resolve();
  const expected = {
    answer,
    status,
    error: status === "failed" ? "Saved failure" : null,
  };
  expect(btw.exchanges[0]).toMatchObject(expected);
  expect(session.thread[0]).toMatchObject(expected);
  expect(streamReply).not.toHaveBeenCalled();
  expect(createReply).not.toHaveBeenCalled();
});

it("creates a document session using its displayed origin and sends subsequent turns to that session", async () => {
  const onCreated = vi.fn();
  const session = new Session({
    originPath: "wiki/test.md",
    initialQuery: "Start here",
    onSessionCreated: onCreated,
  });
  threads.push(session);
  await vi.waitFor(() => expect(session.phase).toBe("done"));
  expect(session.origin).toEqual({
    kind: "document",
    doc_path: "wiki/test.md",
    origin_scope: "vault",
    anchor: null,
    paragraph: null,
    paragraph_index: null,
  });
  expect(vi.mocked(createReply).mock.calls[0][0]).toMatchObject({
    origin_path: "wiki/test.md",
    session: { kind: "new", conversation_kind: "session", origin: session.origin },
  });
  expect(onCreated).toHaveBeenCalledExactlyOnceWith(sessionId);

  session.submitQuery("Follow up");
  await vi.waitFor(() => expect(session.thread[1].answer).toBe("Completed answer"));
  expect(vi.mocked(createReply).mock.calls[1][0].session).toEqual({
    kind: "existing",
    id: sessionId,
  });
  expect(onCreated).toHaveBeenCalledTimes(1);
});

const makeSavedView = (
  kind: "session" | "btw",
  detail: Extract<OriginSessionDetail, { availability: "available" }>,
) => {
  if (kind === "btw") return makeBtw(origins[0], detail);
  const session = new Session({
    saved: {
      id: sessionId,
      kind: "session",
      origin_title: null,
      threads: [],
      events: detail.events,
      activity: detail.activity,
    },
  });
  threads.push(session);
  return session;
};
const viewTurns = (view: Session | Btw) => (view instanceof Session ? view.thread : view.exchanges);

it.each(["session", "btw"] as const)(
  "keeps %s finalizing after reload and preserves recorded content until the operation is terminal",
  async (kind) => {
    const observed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const detail = saved(origins[0], "completed", "Recorded answer");
    const view = makeSavedView(kind, {
      ...detail,
      activity: { reply_id: replyId, status: "settling" },
      events: detail.events.map((event) =>
        event.type === "exchange" ? { ...event, version: 5 } : event,
      ),
    });
    vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
      yield snapshot("Stale running partial", "running", id, 6);
      observed.resolve();
      await finish.promise;
      yield snapshot("Stale terminal cache", "completed", id, 7);
    });
    await observed.promise;
    expect(viewTurns(view)[0]).toMatchObject({
      answer: "Recorded answer",
      status: "completed",
      version: 6,
    });
    if (view instanceof Session) {
      expect(view.phase).toBe("finalizing");
      expect(view.canStop).toBe(false);
      view.submitQuery("Must wait");
    } else {
      expect(view.finalizing).toBe(true);
      view.reply("Must wait");
    }
    expect(createReply).not.toHaveBeenCalled();
    expect(retryReply).not.toHaveBeenCalled();
    finish.resolve();
    await vi.waitFor(() => expect(view.activity).toBeNull());
    expect(viewTurns(view)[0].answer).toBe("Recorded answer");
  },
);

it.each(["session", "btw"] as const)(
  "uses the hydrated %s version and ignores another reply's higher version",
  async (kind) => {
    const observed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const detail = saved(origins[0], "running", "Hydrated partial");
    vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
      yield snapshot("Older partial", "running", id, 4);
      yield snapshot("Wrong attempt", "running", nextReplyId, 999);
      observed.resolve();
      await finish.promise;
      yield snapshot("Finished", "completed", id, 6);
    });
    const view = makeSavedView(kind, {
      ...detail,
      events: detail.events.map((event) =>
        event.type === "exchange" ? { ...event, version: 5 } : event,
      ),
    });
    await observed.promise;
    expect(viewTurns(view)[0]).toMatchObject({ answer: "Hydrated partial", version: 5 });
    finish.resolve();
    await vi.waitFor(() => expect(viewTurns(view)[0].answer).toBe("Finished"));
    expect(createReply).not.toHaveBeenCalled();
  },
);

it("does not offer a new main reply after losing updates and reconnects the same operation", async () => {
  vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
    yield snapshot("Partial", "running", id);
    throw new Error("Disconnected");
  });
  const view = makeSavedView("session", saved(origins[0]));
  if (!(view instanceof Session)) throw new Error("Expected session");
  await vi.waitFor(() => expect(view.connectionError).toBeTruthy());
  expect(view.phase).toBe("streaming");
  view.submitQuery("Must not generate again");
  view.retryExchange(exchangeId);
  expect(createReply).not.toHaveBeenCalled();
  expect(retryReply).not.toHaveBeenCalled();
  view.reconnect();
  await vi.waitFor(() => expect(view.phase).toBe("done"));
  expect(vi.mocked(streamReply).mock.calls.map(([id]) => id)).toEqual([replyId, replyId]);
  expect(view.connectionError).toBeNull();
});

it("retains unavailable note identity without treating missing content as an editable empty thread", async () => {
  const detail = saved(origins[0], "completed");
  const view = makeBtw(origins[0], {
    availability: "unavailable",
    session: detail.session,
    detail: "This conversation is unavailable. Reload to try again.",
  });
  await Promise.resolve();
  expect(view.conversation?.id).toBe(sessionId);
  expect(view.unavailable).toBeTruthy();
  expect(view.draft).toBe(false);
  expect(view.busy).toBe(true);
  view.reply("Do not replace missing history");
  await view.openSession();
  expect(streamReply).not.toHaveBeenCalled();
  expect(createReply).not.toHaveBeenCalled();
  expect(continueAsSession).not.toHaveBeenCalled();
});

it.each(["session", "btw"] as const)(
  "keeps %s busy and reconnects its active retry even when it is not the last exchange",
  async (kind) => {
    const detail = saved(origins[0], "running", "Retry partial");
    const event = detail.events[0];
    if (event.type !== "exchange") throw new Error("Expected exchange");
    vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
      yield snapshot("Retry partial", "running", id);
      throw new Error("Disconnected");
    });
    const view = makeSavedView(kind, {
      ...detail,
      events: [
        ...detail.events,
        {
          ...event,
          exId: Uuid.make("00000000-0000-4000-8000-000000000005"),
          reply_id: nextReplyId,
          status: "completed",
          answer: "Later exchange",
          version: null,
        },
      ],
    });
    await vi.waitFor(() => expect(view.connectionError).toBeTruthy());
    if (view instanceof Session) {
      expect(view.phase).toBe("streaming");
      view.submitQuery("Must wait");
      view.reconnect();
    } else {
      expect(view.busy).toBe(true);
      view.reply("Must wait");
      view.retry(view.exchanges[1].id);
    }
    await vi.waitFor(() => expect(view.activity).toBeNull());
    expect(vi.mocked(streamReply).mock.calls.map(([id]) => id)).toEqual([replyId, replyId]);
    expect(viewTurns(view).map((turn) => turn.answer)).toEqual([
      "Completed answer",
      "Later exchange",
    ]);
    expect(createReply).not.toHaveBeenCalled();
    expect(retryReply).not.toHaveBeenCalled();
  },
);

it("does not dismiss an unavailable saved answer note as an empty draft", () => {
  const parent = saved(origins[0], "completed", "Parent answer");
  const child = saved(origins[2], "completed");
  const view = new Session({
    saved: {
      id: sessionId,
      kind: "session",
      origin_title: null,
      activity: null,
      events: parent.events,
      threads: [
        {
          availability: "unavailable",
          detail: "History unavailable",
          session: { ...child.session, id: SessionId.make("saved-child") },
        },
      ],
    },
  });
  threads.push(view);
  const note = view.thread[0].btws[0];
  expect(note.unavailable).toBeTruthy();
  view.dismissBtw(note.id);
  expect(view.thread[0].btws).toHaveLength(1);
});
