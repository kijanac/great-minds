import { describe, expect, it } from "vitest";

import { iterateSseMessages, type SseMessage } from "./sse";

function streamFrom(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function parseChunks(chunks: readonly string[]): Promise<SseMessage[]> {
  const messages: SseMessage[] = [];
  for await (const message of iterateSseMessages(streamFrom(chunks))) {
    messages.push(message);
  }
  return messages;
}

describe("SSE stream adapter", () => {
  it("parses comments, defaults, multiline data, CRLF, and significant whitespace", async () => {
    const input =
      ": keepalive\r\n" +
      "data: default\r\n\r\n" +
      "event: update\r\n" +
      "data: first\r\n" +
      "data:  second \r\n\r\n";

    await expect(parseChunks(Array.from(input))).resolves.toEqual([
      { event: "message", data: "default" },
      { event: "update", data: "first\n second " },
    ]);
  });

  it("does not dispatch comments or incomplete events", async () => {
    await expect(parseChunks([": heartbeat\n\n", "data: pending"])).resolves.toEqual([]);
  });

  it("cancels the response body when its consumer stops early", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: complete\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const message of iterateSseMessages(body)) {
      expect(message).toEqual({ event: "message", data: "complete" });
      break;
    }

    expect(cancelled).toBe(true);
  });

  it("cancels a pending stream read when aborted", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const iterator = iterateSseMessages(body, controller.signal)[Symbol.asyncIterator]();
    const next = iterator.next();

    controller.abort();

    await expect(next).resolves.toEqual({ done: true, value: undefined });
    expect(cancelled).toBe(true);
  });
});
