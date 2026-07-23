import { createQuery } from "@tanstack/svelte-query";

import { loadSession, type SessionEvent } from "$lib/api/sessions";
import { activeVault } from "$lib/hooks/use-vault.svelte";
import type { BtwThread, Exchange } from "$lib/types";

function replayEvents(events: SessionEvent[]): Exchange[] {
  const exchanges: Exchange[] = [];
  const latestBtw = new Map<string, Extract<SessionEvent, { type: "btw" }>>();

  for (const event of events) {
    if (event.type === "exchange") {
      exchanges.push({
        id: event.exId,
        query: event.query,
        thinking: event.thinking,
        answer: event.answer,
        btws: [],
        streaming: false,
      });
    } else if (event.type === "btw") {
      const key = `${event.exId}\0${event.quote}`;
      const existing = latestBtw.get(key);
      if (!existing || event.ts > existing.ts) latestBtw.set(key, event);
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
      exchanges: event.exchanges.map((exchange) => ({
        id: `${event.exId}:${event.blockOffset}:${event.quote}:${exchange.query}`,
        query: exchange.query,
        thinking: exchange.thinking,
        answer: exchange.answer,
        btws: [],
        streaming: false,
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
  return exchanges;
}

export function useSavedSession(sessionId: () => string | null) {
  return createQuery(() => ({
    queryKey: ["vault", activeVault.id, "session", sessionId()],
    queryFn: async () => {
      const data = await loadSession(sessionId()!);
      return replayEvents(data.events);
    },
    enabled: !!sessionId() && !!activeVault.id,
  }));
}
