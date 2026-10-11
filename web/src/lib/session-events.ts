import type { SessionEvent } from "@great-minds/domain";

import type { Exchange } from "$lib/types";

export const replayExchanges = (events: readonly SessionEvent[]): Exchange[] =>
  events
    .filter((event) => event.type === "exchange")
    .map((event) => ({
      id: event.exId,
      query: event.query,
      thinking: event.thinking,
      answer: event.answer,
      btws: [],
      replyId: event.reply_id,
      status: event.status,
      version: event.version,
      error: event.error,
    }));
