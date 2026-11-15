import { SessionId, Uuid, type OriginSessionDetail } from "@great-minds/domain";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import AnswerBlock from "#lib/components/answer-block.svelte";
import BtwThread from "#lib/components/btw-thread.svelte";
import { Conversation } from "#lib/conversation.svelte.ts";
import type { ThreadLike } from "#lib/types.ts";

const sessionId = SessionId.make("saved-note");
const replyId = Uuid.make("00000000-0000-4000-8000-000000000002");
const thread = (overrides: Partial<ThreadLike> = {}): ThreadLike => ({
  id: "saved-note",
  sessionId,
  anchor: { blockOffset: 0, quote: "Passage", context: "Passage" },
  draft: false,
  createdAt: null,
  exchanges: [
    {
      id: Uuid.make("00000000-0000-4000-8000-000000000001"),
      replyId,
      query: "Question",
      answer: "",
      citations: [],
      thinking: [],
      btws: [],
      status: "completed",
      error: null,
      version: null,
    },
  ],
  ...overrides,
});
const session = {
  id: sessionId,
  kind: "btw",
  query: "Question",
  created_at: new Date("2026-09-17T12:00:00Z"),
  updated_at: new Date("2026-09-17T12:00:00Z"),
  user_id: replyId,
  origin: null,
  origin_title: null,
} as const;
const live = (
  status: "running" | "completed",
  patch: Partial<Pick<Conversation, "activity" | "connectionError">>,
) =>
  Object.assign(
    new Conversation({
      detail: {
        availability: "available",
        session,
        activity: null,
        events: [
          {
            type: "exchange",
            exId: Uuid.make("00000000-0000-4000-8000-000000000001"),
            reply_id: replyId,
            version: 1,
            status,
            error: null,
            query: "Question",
            thinking: [],
            answer: status === "running" ? "Partial" : "Recorded answer",
            citations: [],
            ts: null,
          },
        ],
      },
    }),
    patch,
  );
const markup = (btw: ThreadLike) => render(BtwThread, { props: { btw } }).body;
describe("conversation status markup", () => {
  it("keeps an unsent BTW reachable when collapsed without exposing saved threads", () => {
    const draft = thread({
      id: "draft-note",
      sessionId: null,
      draft: true,
      exchanges: [],
    });
    const html = render(AnswerBlock, {
      props: {
        text: "Passage",
        exchangeId: Uuid.make("00000000-0000-4000-8000-000000000001"),
        btws: [draft, thread()],
        streaming: false,
        expandedThreads: new Set<string>(),
      },
    }).body;
    expect(html).toContain('data-btw-id="draft-note"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-btw-id="saved-note"');
    expect(html).toContain('hidden=""');
  });

  it("does not present an empty completed answer as a failed generation", () => {
    const html = markup(thread());
    expect(html).toContain("The response completed without an answer.");
    expect(html).not.toContain("Couldn’t generate an answer.");
    expect(html).not.toContain("Try again");
  });

  it("shows saving and disables reply input until finalization completes", () => {
    const html = markup(live("completed", { activity: { reply_id: replyId, status: "settling" } }));
    expect(html).toContain("Saving response…");
    expect(html).toMatch(/<textarea[^>]*disabled/u);
    expect(html).toContain("Open full page");
    expect(html).not.toContain("Try again");
  });

  it("shows an unavailable note without offering an empty replacement form", () => {
    const detail: OriginSessionDetail = {
      availability: "unavailable",
      session,
      detail: "History is unavailable.",
    };
    const html = markup(new Conversation({ detail }));
    expect(html).toContain("History is unavailable.");
    expect(html).toContain("Try loading this note again");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Couldn’t generate an answer.");
  });

  it("offers reconnection and Stop, not a generation retry, when live updates are unavailable", () => {
    const html = markup(
      live("running", {
        activity: { reply_id: replyId, status: "running" },
        connectionError: "Live updates are unavailable.",
      }),
    );
    expect(html).toContain("Reconnect");
    expect(html).toContain("Partial");
    expect(html).toContain('aria-label="Stop generating"');
    expect(html).not.toContain("Try again");
  });
});
