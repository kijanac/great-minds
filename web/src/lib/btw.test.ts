import { SessionId, Uuid, type OriginSessionDetail, type SessionOrigin } from "@great-minds/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReply, retryReply, streamReply, type ReplySnapshot } from "$lib/api/replies";
import { continueAsSession } from "$lib/api/sessions";
import { Btw } from "$lib/btw.svelte";
import { queryClient } from "$lib/query-client";
import { Session } from "$lib/session.svelte";

vi.mock("$app/environment", () => ({ browser: true }));
vi.mock("$lib/api/replies", () => ({
  createReply: vi.fn(),
  retryReply: vi.fn(),
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

const saved = (origin: SessionOrigin, answer = ""): OriginSessionDetail => ({
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
      query: "Replayed question",
      thinking: [],
      answer,
      ts: now,
    },
  ],
});

const snapshot = (
  answer: string,
  status: ReplySnapshot["status"] = "completed",
): ReplySnapshot => ({
  reply_id: replyId,
  session_id: sessionId,
  kind: "exchange",
  status,
  answer,
  sources: [],
  error: null,
  version: 1,
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
  vi.mocked(createReply).mockImplementation(async (payload) => ({
    session_id: sessionId,
    reply_id: payload.reply_id,
  }));
  vi.mocked(retryReply).mockResolvedValue({ session_id: sessionId, reply_id: nextReplyId });
  vi.mocked(streamReply).mockImplementation(async function* () {
    yield snapshot("Completed answer");
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

  it("reconnects a saved reply, keeps partial text when retrying fails, and retains an accepted retry after a stream failure", async () => {
    vi.mocked(streamReply).mockImplementationOnce(async function* () {
      yield snapshot("Partial answer", "running");
      throw new Error("connection lost");
    });
    const btw = makeBtw(origin, saved(origin));
    await vi.waitFor(() => expect(btw.exchanges[0].error).toBeTruthy());
    expect(createReply).not.toHaveBeenCalled();
    expect(streamReply).toHaveBeenCalledWith(replyId, expect.any(AbortSignal));

    vi.mocked(retryReply).mockRejectedValueOnce(new Error("offline"));
    btw.retry(exchangeId);
    await vi.waitFor(() => expect(btw.exchanges[0].streaming).toBe(false));
    expect(btw.exchanges[0]).toMatchObject({ answer: "Partial answer", replyId });

    vi.mocked(streamReply).mockImplementationOnce(async function* () {
      yield snapshot("New partial answer", "running");
      throw new Error("connection lost again");
    });
    btw.retry(exchangeId);
    await vi.waitFor(() => expect(btw.exchanges[0].error).toBeTruthy());
    expect(btw.exchanges[0]).toMatchObject({
      answer: "New partial answer",
      replyId: nextReplyId,
      streaming: false,
    });
    expect(btw.conversation?.query).toBe("Canonical question");
  });
});

it("promotes once, retains the canonical title without a transcript, and becomes a link", async () => {
  const detail = saved(origins[0]);
  const onOpen = vi.fn();
  const btw = makeBtw(origins[0], { ...detail, events: [] }, onOpen);
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
  const btw = makeBtw(origins[0], saved(origins[0], "Answer"), onOpen);
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
  const session = new Session({
    saved: {
      id: sessionId,
      kind: "session",
      origin_title: "Original document",
      events: [
        {
          type: "meta",
          id: sessionId,
          query: "Parent question",
          ts: now,
          user_id: exchangeId,
          origin: origins[0],
        },
        ...saved(origins[0], "Parent answer").events,
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
