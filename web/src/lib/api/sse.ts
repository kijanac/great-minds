import { createParser, type EventSourceMessage } from "eventsource-parser";

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

export async function* iterateSseMessages(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const pending: EventSourceMessage[] = [];
  const parser = createParser({
    onEvent: (message) => pending.push(message),
  });
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", cancel, { once: true });

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (signal?.aborted) return;
      if (done) {
        const trailing = decoder.decode();
        if (trailing) parser.feed(trailing);
      } else {
        parser.feed(decoder.decode(value, { stream: true }));
      }

      for (const message of pending) {
        yield {
          event: message.event ?? "message",
          data: message.data,
          ...(message.id === undefined ? {} : { id: message.id }),
        };
      }
      pending.length = 0;
      if (done) return;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
