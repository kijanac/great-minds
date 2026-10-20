import { SessionId, Uuid } from "@great-minds/domain";
import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import AnswerBlock from "$lib/components/answer-block.svelte";
import BtwThread from "$lib/components/btw-thread.svelte";
import type { ThreadLike } from "$lib/types";

const thread = (overrides: Partial<ThreadLike> = {}): ThreadLike => ({
  id: "saved-note",
  conversation: { id: SessionId.make("saved-note"), kind: "btw", query: "Question" },
  anchor: { blockOffset: 0, quote: "Passage", context: "Passage" },
  draft: false,
  createdAt: null,
  exchanges: [
    {
      id: Uuid.make("00000000-0000-4000-8000-000000000001"),
      replyId: Uuid.make("00000000-0000-4000-8000-000000000002"),
      query: "Question",
      answer: "",
      thinking: [],
      btws: [],
      status: "completed",
      error: null,
      version: null,
    },
  ],
  ...overrides,
});
const markup = (btw: ThreadLike) =>
  render(BtwThread, { props: { btw, onReply: vi.fn(), onRetry: vi.fn() } }).body;

describe("conversation status markup", () => {
  it("keeps an unsent BTW reachable when collapsed without exposing saved threads", () => {
    const draft = thread({ id: "draft-note", conversation: null, draft: true, exchanges: [] });
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
    const html = markup(thread({ busy: true, finalizing: true }));
    expect(html).toContain("Saving response…");
    expect(html).toMatch(/<textarea[^>]*disabled/u);
    expect(html).not.toContain("Try again");
  });

  it("shows an unavailable note without offering an empty replacement form", () => {
    const html = markup(
      thread({ unavailable: "History is unavailable.", busy: true, exchanges: [] }),
    );
    expect(html).toContain("History is unavailable.");
    expect(html).toContain("Try loading this note again");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Couldn’t generate an answer.");
  });

  it("offers reconnection, not a generation retry, when live updates are unavailable", () => {
    const saved = thread();
    const html = markup({
      ...saved,
      busy: true,
      connectionError: "Live updates are unavailable.",
      exchanges: saved.exchanges.map((turn) => ({ ...turn, status: "running", answer: "Partial" })),
    });
    expect(html).toContain("Reconnect");
    expect(html).toContain("Partial");
    expect(html).not.toContain("Try again");
  });
});
