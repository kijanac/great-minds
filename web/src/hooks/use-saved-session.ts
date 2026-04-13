import { useQuery } from "@tanstack/react-query";

import { loadSession, type SessionEvent } from "@/api/sessions";
import { useActiveBrainId } from "@/hooks/use-brain";
import type { BtwThread, Exchange } from "@/lib/types";

function replayEvents(events: SessionEvent[]): Exchange[] {
  const exchanges: Exchange[] = [];
  const btwsByEx = new Map<string, BtwThread[]>();

  for (const event of events) {
    if (event.type === "exchange") {
      const ex: Exchange = {
        id: event.exId,
        query: event.query,
        thinking: event.thinking,
        answer: event.answer,
        btws: [],
      };
      exchanges.push(ex);
    } else if (event.type === "btw") {
      const exId = event.exId;
      const btw: BtwThread = {
        id: `${exId}:${event.pi}:${event.anchor}`,
        anchor: event.anchor,
        paragraph: event.paragraph,
        paragraphIndex: event.pi,
        exchangeId: exId,
        messages: event.messages,
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
  const brainId = useActiveBrainId();
  return useQuery({
    queryKey: ["brain", brainId, "session", sessionId],
    queryFn: async () => {
      const data = await loadSession(sessionId!);
      return replayEvents(data.events);
    },
    enabled: !!sessionId && !!brainId,
  });
}
