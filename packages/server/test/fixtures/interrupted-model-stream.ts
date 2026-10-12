import { expect, vi } from "vitest";

import { parseOpenRouterStream, type ModelStreamPart } from "../../src/llm.ts";

export async function* stalledModelStream(
  partial: string,
  onTimeout: () => void,
): AsyncIterable<ModelStreamPart> {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      controller = stream;
      if (partial.length > 0) {
        stream.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: partial } }],
            })}\n\n`,
          ),
        );
      }
    },
  });
  const parser = parseOpenRouterStream(new Response(body))[Symbol.asyncIterator]();
  if (partial.length > 0) {
    const token = await parser.next();
    if (token.done) throw new Error("Expected a partial token");
    yield token.value;
  }
  const schedule = globalThis.setTimeout;
  const timer = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementationOnce((callback, delay, ...args) => {
      timer.mockRestore();
      expect(delay).toBe(30_000);
      return schedule(() => {
        onTimeout();
        callback(...args);
      }, 0);
    });
  try {
    const next = await parser.next();
    if (!next.done) yield next.value;
  } finally {
    timer.mockRestore();
    controller?.close();
    await parser.return?.();
  }
}
