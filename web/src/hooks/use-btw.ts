import { useCallback, useEffect, useRef, useState } from "react";

import { consumeStream, streamQuery } from "@/api/query";
import { appendExchange, createSession } from "@/api/sessions";
import { useViewNavigate } from "@/hooks/use-view-navigate";
import type { BtwThread, Exchange, SelectionInfo } from "@/lib/types";
import { buildBtwHistory, buildBtwQuery, genId, isAbortError } from "@/lib/utils";

export function useBtw(originPath?: string) {
  const navigate = useViewNavigate();
  const [btws, setBtws] = useState<BtwThread[]>([]);
  const btwsRef = useRef(btws);
  const cleanupRef = useRef<(() => void)[]>([]);

  useEffect(() => {
    btwsRef.current = btws;
  }, [btws]);

  // Self-contained unmount cleanup — intervals are cleared
  // regardless of what the consumer does
  useEffect(() => {
    return () => {
      for (const fn of cleanupRef.current) fn();
      cleanupRef.current = [];
    };
  }, []);

  const startBtw = useCallback((info: SelectionInfo) => {
    const btwId = genId("btw");
    const btw: BtwThread = {
      id: btwId,
      exchangeId: info.exchangeId,
      anchor: { blockOffset: info.blockOffset, quote: info.quote, context: info.context },
      exchanges: [],
    };
    setBtws((prev) => [...prev, btw]);
  }, []);

  const replyBtw = useCallback(
    (btwId: string, userText: string) => {
      const target = btwsRef.current.find((b) => b.id === btwId);
      const anchor = target?.anchor ?? { blockOffset: -1, quote: "", context: "" };
      const priorExchanges = target?.exchanges ?? [];
      const isFirst = priorExchanges.length === 0;
      const turnId = genId("ex");

      const patchExchanges = (mut: (exchanges: Exchange[]) => Exchange[]) =>
        setBtws((prev) =>
          prev.map((b) => (b.id === btwId ? { ...b, exchanges: mut(b.exchanges) } : b)),
        );
      const patchTurn = (patch: Partial<Exchange>) =>
        patchExchanges((exs) => exs.map((e) => (e.id === turnId ? { ...e, ...patch } : e)));

      // Optimistic in-flight turn — patched in place as the reply streams.
      patchExchanges((exs) => [
        ...exs,
        { id: turnId, query: userText, thinking: [], answer: "", btws: [], streaming: true },
      ]);

      // First turn: passage prefix on the question.
      // Follow-ups: passage prefix re-attached to turn 1 of priorExchanges (in buildBtwHistory).
      const question = isFirst ? buildBtwQuery(anchor, userText) : userText;
      const history = buildBtwHistory(priorExchanges, anchor);

      const controller = new AbortController();
      cleanupRef.current.push(() => controller.abort());

      (async () => {
        try {
          const { answer, sources } = await consumeStream(
            streamQuery(question, { originPath, history, mode: "btw", signal: controller.signal }),
            {
              onSources: (s) => patchTurn({ thinking: [{ sources: s }] }),
              onToken: (text) => patchTurn({ answer: text }),
            },
          );

          patchTurn({ thinking: sources.length > 0 ? [{ sources }] : [], answer, streaming: false });
        } catch (err) {
          if (isAbortError(err)) return;
          // Unwind the provisional turn so it doesn't hang in a streaming state.
          patchExchanges((exs) => exs.filter((e) => e.id !== turnId));
        }
      })();
    },
    [originPath],
  );

  const spinOff = useCallback(
    async (btwId: string) => {
      if (!originPath) return;
      const target = btwsRef.current.find((b) => b.id === btwId);
      if (!target || target.exchanges.some((e) => e.streaming) || target.exchanges.length === 0)
        return;

      const sid = genId("s");
      const origin = {
        doc_path: originPath,
        anchor: target.anchor.quote,
      };

      try {
        await createSession(sid, target.exchanges[0], origin);
        for (let i = 1; i < target.exchanges.length; i++) {
          await appendExchange(sid, target.exchanges[i]);
        }
        setBtws((prev) => prev.filter((b) => b.id !== btwId));
        navigate(`/sessions/${sid}`);
      } catch (e) {
        console.error("Failed to spin off BTW:", e);
      }
    },
    [originPath, navigate],
  );

  const dismissEmpty = useCallback((btwId: string) => {
    setBtws((prev) => {
      const target = prev.find((b) => b.id === btwId);
      if (target && target.exchanges.length === 0) {
        return prev.filter((b) => b.id !== btwId);
      }
      return prev;
    });
  }, []);

  const cleanup = useCallback(() => {
    for (const fn of cleanupRef.current) fn();
    cleanupRef.current = [];
    setBtws([]);
  }, []);

  return { btws, startBtw, replyBtw, spinOff, dismissEmpty, cleanup };
}
