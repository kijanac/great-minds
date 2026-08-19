import { createQuery } from "@tanstack/svelte-query";

import { loadSession, type SessionEvent, type SessionOrigin } from "$lib/api/sessions";
import { activeVault } from "$lib/hooks/use-vault.svelte";
import type { BtwThread, Exchange } from "$lib/types";

export interface SavedSession {
  exchanges: Exchange[];
  origin: SessionOrigin | null;
  originTitle: string | null;
}

function replayEvents(events: SessionEvent[], originTitle: string | null): SavedSession {
  const exchanges: Exchange[] = [];
  const exchangeIndexes = new Map<string, number>();
  const latestBtw = new Map<string, Extract<SessionEvent, { type: "btw" }>>();

  for (const event of events) {
    if (event.type === "exchange") {
      const exchange: Exchange = {
        id: event.exId,
        query: event.query,
        thinking: event.thinking,
        answer: event.answer,
        btws: [],
        replyId: event.reply_id,
        streaming: event.answer.length === 0 && event.reply_id !== undefined,
      };
      const existingIndex = exchangeIndexes.get(event.exId);
      if (existingIndex === undefined) {
        exchangeIndexes.set(event.exId, exchanges.length);
        exchanges.push(exchange);
      } else {
        exchanges[existingIndex] = exchange;
      }
    } else if (event.type === "btw") {
      const key = `${event.exId}\0${event.quote}`;
      const existing = latestBtw.get(key);
      if (!existing || event.ts >= existing.ts) latestBtw.set(key, event);
    }
  }

  const btwsByExchange = new Map<string, BtwThread[]>();
  for (const event of latestBtw.values()) {
    const btw: BtwThread = {
      id: `${event.exId}:${event.blockOffset}:${event.quote}`,
      exchangeId: event.exId,
      anchor: {
        blockOffset: event.blockOffset,
        quote: event.quote,
        context: event.context,
      },
      exchanges: event.exchanges.map((exchange, index) => ({
        id: `${event.exId}:${event.blockOffset}:${event.quote}:${index}`,
        query: exchange.query,
        thinking: exchange.thinking,
        answer: exchange.answer,
        btws: [],
        ...(index === event.exchanges.length - 1 && event.reply_id !== undefined
          ? { replyId: event.reply_id }
          : {}),
        streaming:
          index === event.exchanges.length - 1 &&
          exchange.answer.length === 0 &&
          event.reply_id !== undefined,
      })),
    };
    if (!btwsByExchange.has(event.exId)) {
      btwsByExchange.set(event.exId, []);
    }
    btwsByExchange.get(event.exId)!.push(btw);
  }

  for (const exchange of exchanges) {
    exchange.btws = btwsByExchange.get(exchange.id) ?? [];
  }
  const meta = events.find(
    (event): event is Extract<SessionEvent, { type: "meta" }> => event.type === "meta",
  );
  return { exchanges, origin: meta?.origin ?? null, originTitle };
}

export function useSavedSession(sessionId: () => string | null) {
  return createQuery(() => ({
    queryKey: ["vault", activeVault.id, "session", sessionId()],
    queryFn: async () => {
      const data = await loadSession(sessionId()!);
      return replayEvents(data.events, data.origin_title);
    },
    enabled: !!sessionId() && !!activeVault.id,
  }));
}
