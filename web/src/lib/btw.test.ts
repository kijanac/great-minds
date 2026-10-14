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
const passage = { anchor: "quote", paragraph: "A quote in context.", paragraph_index: 10 };
const origins: SessionOrigin[] = [
  { kind: "document", doc_path: "wiki/test.md", origin_scope: "vault", ...passage },
  { kind: "document", doc_path: "raw/test.md", origin_scope: "personal", ...passage },
  { kind: "answer", session_id: sessionId, exchange_id: exchangeId, ...passage },
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
const makeSession = (options?: ConstructorParameters<typeof Session>[0]) => {
  const thread = new Session(options);
  threads.push(thread);
  return thread;
};
const makeSavedView = (kind: "session" | "btw", detail: Available) =>
  kind === "btw" ? makeBtw(origins[0], detail) : makeSession({ saved: sessionData(detail) });
const viewTurns = (view: Session | Btw) => (view instanceof Session ? view.thread : view.exchanges);

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

it.each(origins)(
  "replays unacknowledged BTW creation with $kind origin and original IDs, then follows up in the same session",
  async (origin) => {
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
  },
);

it("reconnects BTW observation before allowing a confirmed failure to create a new generation", async () => {
  vi.mocked(streamReply).mockImplementationOnce(async function* () {
    yield snapshot("Partial answer", "running");
    throw new Error("connection lost");
  });
  const btw = makeBtw(origins[0], saved(origins[0]));
  await vi.waitFor(() => expect(btw.connectionError).toBeTruthy());
  btw.reply("Do not replace");
  expect(createReply).not.toHaveBeenCalled();
  expect(streamReply).toHaveBeenCalledWith(replyId, expect.any(AbortSignal));
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

it("continues once, retains the canonical title with an empty answer, and becomes a link", async () => {
  const onOpen = vi.fn();
  const btw = makeBtw(origins[0], saved(origins[0], "completed"), onOpen);
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

it("keeps failed continuation editable and ignores navigation after destruction", async () => {
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

it("aborts only the disposed thread, blocks Continue while running and leaves another thread streaming", async () => {
  const finish = Promise.withResolvers<void>();
  vi.mocked(streamReply).mockImplementation(async function* () {
    yield snapshot("Streaming", "running");
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

it("hydrates saved origin and attached BTW without resubmitting either conversation", async () => {
  const detail = saved(origins[2]);
  const childId = SessionId.make("saved-child");
  vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
    yield { ...snapshot("Completed answer", "completed", id), session_id: childId };
  });
  const session = makeSession({
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
    originPath: "wiki/not-the-origin.md",
  });
  await vi.waitFor(() =>
    expect(session.thread[0].btws[0].exchanges[0].answer).toBe("Completed answer"),
  );
  expect(createReply).not.toHaveBeenCalled();
  expect(session.origin).toEqual(origins[0]);
  expect(session.originTitle).toBe("Original document");
  expect(session.thread[0].answer).toBe("Parent answer");
  expect(session.thread[0].btws[0].conversation?.id).toBe(childId);
});

it.each([undefined, "wiki/test.md"])(
  "creates and follows up a session with origin %s without duplicating its creation callback",
  async (originPath) => {
    const onCreated = vi.fn();
    const session = makeSession({
      originPath,
      onSessionCreated: onCreated,
      initialQuery: originPath === undefined ? undefined : "Start here",
    });
    if (originPath === undefined) session.submitQuery("Start here");
    await vi.waitFor(() => expect(session.thread[0]?.answer).toBe("Completed answer"));
    const first = vi.mocked(createReply).mock.calls[0][0];
    expect(first).not.toHaveProperty("mode");
    expect(first.session).toMatchObject({ kind: "new", conversation_kind: "session" });
    if (originPath === undefined) expect(first).not.toHaveProperty("origin_path");
    else {
      expect(session.origin).toEqual({
        kind: "document",
        doc_path: originPath,
        origin_scope: "vault",
        anchor: null,
        paragraph: null,
        paragraph_index: null,
      });
      expect(first).toMatchObject({
        origin_path: originPath,
        session: { kind: "new", conversation_kind: "session", origin: session.origin },
      });
    }
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(sessionId);
    session.submitQuery("Follow up");
    await vi.waitFor(() => expect(session.thread[1]?.answer).toBe("Completed answer"));
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
    const session = makeSession();
    session.submitQuery("Question");
    expect(session.canStop).toBe(false);
    await vi.waitFor(() => expect(session.canStop).toBe(true));
    await session.stop();
    expect(session.stopFailed).toBe(true);
    expect(session.canStop).toBe(true);
    if (status === "stopped") {
      await Promise.all([session.stop(), session.stop()]);
      expect(stopReply).toHaveBeenCalledTimes(2);
      expect(stopReply).toHaveBeenLastCalledWith(
        session.thread[0].replyId,
        expect.any(AbortSignal),
      );
      expect(session.stopping).toBe(true);
    }
    expect(session.phase).toBe("streaming");
    expect(session.thread[0].answer).toBe("Partial answer");
    terminal.resolve();
    await vi.waitFor(() => expect(session.phase).toBe("done"));
    expect(session.stopping).toBe(false);
    expect(session.stopFailed).toBe(false);
    expect(session.canStop).toBe(false);
    expect(session.thread[0]).toMatchObject({ status, answer: "Partial answer", error: null });
    session.followUpDraft = "Continue";
    session.submitFollowUp();
    await vi.waitFor(() => expect(session.thread[1]?.answer).toBe("Completed answer"));
  },
);

it.each([
  ["stopped", ""],
  ["stopped", "Partial answer"],
  ["completed", ""],
  ["failed", ""],
  ["failed", "Private partial answer"],
] as const)("hydrates %s with %j in both views without regenerating", async (status, answer) => {
  const detail = saved(origins[0], status, answer);
  const views = [makeSavedView("btw", detail), makeSavedView("session", detail)];
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const view of views) {
    expect(viewTurns(view)[0]).toMatchObject({
      answer,
      status,
      error: status === "failed" ? "Saved failure" : null,
    });
    if (view instanceof Session) expect(view.phase).toBe("done");
  }
  expect(streamReply).not.toHaveBeenCalled();
  expect(createReply).not.toHaveBeenCalled();
});

it.each(["session", "btw"] as const)(
  "keeps %s finalizing and preserves recorded content until terminal confirmation",
  async (kind) => {
    const observed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const detail = saved(origins[0], "completed", "Recorded answer");
    vi.mocked(streamReply).mockImplementationOnce(async function* (id) {
      yield snapshot("Stale running partial", "running", id, 6);
      observed.resolve();
      await finish.promise;
      yield snapshot("Stale terminal cache", "completed", id, 7);
    });
    const view = makeSavedView(kind, {
      ...detail,
      activity: { reply_id: replyId, status: "settling" },
      events: detail.events.map((event) =>
        event.type === "exchange" ? { ...event, version: 5 } : event,
      ),
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
  "rejects stale/wrong-identity snapshots and reconnects the earlier active %s turn without generating",
  async (kind) => {
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
    const view = makeSavedView(kind, {
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
    });
    await vi.waitFor(() => expect(view.connectionError).toBeTruthy());
    expect(viewTurns(view)[0]).toMatchObject({ answer: "Hydrated partial", version: 5 });
    if (view instanceof Session) {
      expect(view.phase).toBe("streaming");
      view.submitQuery("Must wait");
      view.retryExchange(exchangeId);
      expect(retryReply).not.toHaveBeenCalled();
      view.reconnect();
    } else {
      expect(view.busy).toBe(true);
      view.reply("Must wait");
      view.retry(view.exchanges[1].id);
    }
    await vi.waitFor(() => expect(view.activity).toBeNull());
    expect(view.connectionError).toBeNull();
    expect(vi.mocked(streamReply).mock.calls.map(([id]) => id)).toEqual([replyId, replyId]);
    expect(viewTurns(view).map((turn) => turn.answer)).toEqual([
      "Completed answer",
      "Later exchange",
    ]);
    expect(createReply).not.toHaveBeenCalled();
    expect(retryReply).not.toHaveBeenCalled();
  },
);

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
  const view = makeSession({ saved: sessionData(saved(origins[0])) });
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

describe.each(["session", "btw"] as const)("%s retry acknowledgment", (kind) => {
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
      const view = makeSavedView(kind, saved(origins[0], "failed", "Original partial"));
      const retry = () =>
        view instanceof Session ? view.retryExchange(exchangeId) : view.retry(exchangeId);
      retry();
      await vi.waitFor(() => expect(viewTurns(view)[0].status).toBe("failed"));
      expect(viewTurns(view)[0]).toMatchObject({ replyId, answer: "Original partial" });
      expect(streamReply).not.toHaveBeenCalled();
      retry();
      expect(vi.mocked(retryReply).mock.calls[1].slice(0, 2)).toEqual(
        vi.mocked(retryReply).mock.calls[0].slice(0, 2),
      );
      await vi.waitFor(() => expect(viewTurns(view)[0].answer).toBe("Recorded retry"));
      expect(viewTurns(view)[0].status).toBe(outcome);
      expect(viewTurns(view)[0].replyId).toBe(accepted.get(replyId));
      expect(accepted.size).toBe(1);
      expect(createReply).not.toHaveBeenCalled();
      if (outcome === "failed") {
        retry();
        await vi.waitFor(() => expect(viewTurns(view)[0].status).toBe("failed"));
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
  const view = makeSession({
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
  const note = view.thread[0].btws[0];
  await Promise.resolve();
  expect(note.conversation?.id).toBe(childId);
  expect(note.unavailable).toBeTruthy();
  expect(note.draft).toBe(false);
  expect(note.busy).toBe(true);
  note.reply("Do not replace missing history");
  await note.openSession();
  view.dismissBtw(note.id);
  expect(view.thread[0].btws).toHaveLength(1);
  expect(streamReply).not.toHaveBeenCalled();
  expect(createReply).not.toHaveBeenCalled();
  expect(continueAsSession).not.toHaveBeenCalled();
});
