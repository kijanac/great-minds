import { useQuery } from "@tanstack/react-query";

import { loadSession, type SessionEvent, type SessionResponse } from "@/api/sessions";
import { useActiveVaultId } from "@/hooks/use-vault";
import type { BtwThread, Exchange } from "@/lib/types";

function replayEvents(events: SessionEvent[]): Exchange[] {
  const exchanges: Exchange[] = [];

  // Each BTW reply persists a fresh full-thread BtwEvent, so multiple events
  // accumulate per (exId, anchor). Dedup to the latest by ts.
  const latestBtw = new Map<string, Extract<SessionEvent, { type: "btw" }>>();

  for (const event of events) {
    if (event.type === "exchange") {
      exchanges.push({
        id: event.exId,
        query: event.query,
        thinking: event.thinking,
        answer: event.answer,
        btws: [],
      });
    } else if (event.type === "btw") {
      const key = `${event.exId}\0${event.anchor}`;
      const existing = latestBtw.get(key);
      if (!existing || event.ts > existing.ts) {
        latestBtw.set(key, event);
      }
    }
  }

  const btwsByEx = new Map<string, BtwThread[]>();
  for (const event of latestBtw.values()) {
    const btw: BtwThread = {
      id: `${event.exId}:${event.pi}:${event.anchor}`,
      anchor: event.anchor,
      paragraph: event.paragraph,
      paragraphIndex: event.pi,
      exchangeId: event.exId,
      exchanges: event.exchanges.map((ex) => ({
        id: `${event.exId}:${event.pi}:${event.anchor}:${ex.query}`,
        query: ex.query,
        thinking: ex.thinking,
        answer: ex.answer,
        btws: [],
      })),
      pendingQuery: null,
      sources: [],
      streaming: false,
      streamText: "",
    };
    if (!btwsByEx.has(event.exId)) btwsByEx.set(event.exId, []);
    btwsByEx.get(event.exId)!.push(btw);
  }

  for (const ex of exchanges) {
    ex.btws = btwsByEx.get(ex.id) ?? [];
  }

  return exchanges;
}

export function useSavedSession(sessionId: string | null) {
  const vaultId = useActiveVaultId();
  return useQuery({
    queryKey: ["vault", vaultId, "session", sessionId],
    queryFn: async () => {
      const data = await loadSession(sessionId!);
      return replayEvents(data.events);
    },
    enabled: !!sessionId && !!vaultId,
  });
}
