import { SessionId, Uuid, type ReplySnapshot } from "@great-minds/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requestCode } from "./auth";
import { streamReply } from "./replies";
import { fetchAllWikiArticles } from "./wiki";
import { ApiError } from "@great-minds/client";

const id = Uuid.make("00000000-0000-4000-8000-000000000001");
const fetchRequest = vi.fn<typeof fetch>();

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("vault_id", id);
  localStorage.setItem("access_token", "fixture");
  fetchRequest.mockReset();
  vi.stubGlobal("fetch", fetchRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function collect(source: AsyncIterable<unknown>) {
  const events: unknown[] = [];
  for await (const event of source) events.push(event);
  return events;
}

const frames = (body: string) =>
  new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });

const reply: ReplySnapshot = {
  reply_id: id,
  session_id: SessionId.make(id),
  status: "running",
  answer: "Partial answer",
  citations: [],
  sources: [],
  error: null,
  version: 1,
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
};
const message = (snapshot: unknown) => `data: ${JSON.stringify(snapshot)}\n\n`;

describe("browser API boundaries", () => {
  it("rejects invalid input through its Promise without HTTP", async () => {
    const pending = requestCode("invalid");
    await expect(pending).rejects.toMatchObject({ _tag: "ApiError", message: "Invalid request" });
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it("keeps reading the requested wiki after the selected vault changes", async () => {
    const items = Array.from({ length: 201 }, (_, index) => ({
      slug: `article-${index}`,
      file_path: `wiki/article-${index}.md`,
      title: `Article ${index}`,
      precis: "",
      updated_at: null,
    }));
    const page = (offset: number) =>
      Response.json({
        items: items.slice(offset, offset + 200),
        pagination: { limit: 200, offset, total: items.length },
      });
    fetchRequest
      .mockImplementationOnce(async () => {
        localStorage.setItem("vault_id", "00000000-0000-4000-8000-000000000002");
        return page(0);
      })
      .mockResolvedValueOnce(page(200));

    expect(await fetchAllWikiArticles(id)).toEqual(items);
    const pages = fetchRequest.mock.calls.map(([request]) => {
      const { pathname, searchParams } = new URL(
        request instanceof Request ? request.url : request,
      );
      return [pathname.split("/").at(-2), searchParams.get("offset")];
    });
    expect(pages).toEqual([
      [id, "0"],
      [id, "200"],
    ]);
  });

  it("rejects malformed messages rather than silently skipping or retrying them", async () => {
    for (const data of ["{bad-json", '{"status":"completed"}']) {
      fetchRequest.mockResolvedValueOnce(frames(`data: ${data}\n\nevent: done\ndata: \n\n`));
      await expect(collect(streamReply(id))).rejects.toBeInstanceOf(ApiError);
    }
    expect(fetchRequest).toHaveBeenCalledTimes(2);
  });

  it("stops on done without exposing a synthetic application event", async () => {
    fetchRequest.mockResolvedValueOnce(
      frames(
        "event: connected\ndata: not-json\n\nevent: done\ndata: \n\ndata: {invalid-after-done\n\n",
      ),
    );
    expect(await collect(streamReply(id))).toEqual([]);
    expect(fetchRequest).toHaveBeenCalledOnce();
  });

  it("delivers decoded snapshots through terminal status and releases the stream", async () => {
    const terminal = { ...reply, status: "completed", version: 2 };
    let cancelled = false;
    fetchRequest.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                message(reply) + message(terminal) + "data: {invalid-after-terminal\n\n",
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    expect(await collect(streamReply(id))).toEqual([reply, terminal]);
    expect(cancelled).toBe(true);
    expect(fetchRequest).toHaveBeenCalledOnce();
  });
});
