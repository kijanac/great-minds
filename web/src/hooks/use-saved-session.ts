import { useEffect, useState } from "react";

import { loadSession, type SessionEvent } from "@/api/sessions";
import type { BtwThread, Exchange } from "@/lib/types";
import { genId } from "@/lib/utils";

function replayEvents(events: SessionEvent[]): Exchange[] {
  const exchanges: Exchange[] = [];
  const btwsByEx = new Map<string, BtwThread[]>();

  for (const event of events) {
    if (event.type === "exchange") {
      const ex: Exchange = {
        id: (event.exId as string) || genId("ex"),
        query: event.query as string,
        thinking: (event.thinking as Exchange["thinking"]) ?? [],
        answer: (event.answer as string) ?? "",
        btws: [],
      };
      exchanges.push(ex);
    } else if (event.type === "btw") {
      const exId = event.exId as string;
      const btw: BtwThread = {
        id: genId("btw"),
        anchor: event.anchor as string,
        paragraph: event.paragraph as string,
        paragraphIndex: (event.pi as number) ?? -1,
        exchangeId: exId,
        messages: (event.messages as BtwThread["messages"]) ?? [],
        sources: [],
        streaming: false,
        streamText: "",
      };
      if (!btwsByEx.has(exId)) btwsByEx.set(exId, []);
      btwsByEx.get(exId)!.push(btw);
    }
  }

  for (const ex of exchanges) {
    ex.btws = btwsByEx.get(ex.id) ?? [];
  }

  return exchanges;
}

export function useSavedSession(sessionId: string | null) {
  const [exchanges, setExchanges] = useState<Exchange[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setExchanges(null);
      return;
    }
    setLoading(true);
    loadSession(sessionId)
      .then((data) => setExchanges(replayEvents(data.events)))
      .catch(() => setExchanges(null))
      .finally(() => setLoading(false));
  }, [sessionId]);

  return { exchanges, loading };
}
