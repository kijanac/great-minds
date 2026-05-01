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
  btwsRef.current = btws;
  const cleanupRef = useRef<(() => void)[]>([]);

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
      anchor: info.text,
      paragraph: info.paragraph,
      paragraphIndex: info.paragraphIndex,
      exchangeId: info.exchangeId,
      exchanges: [],
      pendingQuery: null,
      sources: [],
      streaming: false,
      streamText: "",
    };
    setBtws((prev) => [...prev, btw]);
  }, []);

  const replyBtw = useCallback(
    (btwId: string, userText: string) => {
      const target = btwsRef.current.find((b) => b.id === btwId);
      const anchor = target?.anchor ?? "";
      const paragraph = target?.paragraph ?? "";
      const priorExchanges = target?.exchanges ?? [];
      const isFirst = priorExchanges.length === 0;

      setBtws((prev) =>
        prev.map((b) =>
          b.id !== btwId
            ? b
            : {
                ...b,
                streaming: true,
                streamText: "",
                pendingQuery: userText,
                sources: [],
              },
        ),
      );

      // First turn: passage prefix on the question.
      // Follow-ups: passage prefix re-attached to turn 1 of priorExchanges (in buildBtwHistory).
      const question = isFirst ? buildBtwQuery(paragraph, anchor, userText) : userText;
      const history = buildBtwHistory(priorExchanges, paragraph, anchor);

      const controller = new AbortController();
      cleanupRef.current.push(() => controller.abort());

      const updateBtw = (patch: Partial<BtwThread>) =>
        setBtws((prev) => prev.map((b) => (b.id === btwId ? { ...b, ...patch } : b)));

      (async () => {
        try {
          const { answer, sources } = await consumeStream(
            streamQuery(question, { originPath, history, mode: "btw", signal: controller.signal }),
            {
              onSources: (s) => updateBtw({ sources: s }),
              onToken: (text) => updateBtw({ streamText: text }),
            },
          );

          const newExchange: Exchange = {
            id: genId("ex"),
            query: userText,
            thinking: sources.length > 0 ? [{ sources }] : [],
            answer,
            btws: [],
          };
          setBtws((prev) =>
            prev.map((b) =>
              b.id !== btwId
                ? b
                : {
                    ...b,
                    streaming: false,
                    streamText: "",
                    pendingQuery: null,
                    sources: [],
                    exchanges: [...b.exchanges, newExchange],
                  },
            ),
          );
        } catch (err) {
          if (isAbortError(err)) return;
        }
      })();
    },
    [originPath],
  );

  const spinOff = useCallback(
    async (btwId: string) => {
      if (!originPath) return;
      const target = btwsRef.current.find((b) => b.id === btwId);
      if (!target || target.streaming || target.exchanges.length === 0) return;

      const sid = genId("s");
      const origin = {
        doc_path: originPath,
        anchor: target.anchor,
        paragraph: target.paragraph,
        paragraph_index: target.paragraphIndex,
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
      if (target && target.exchanges.length === 0 && !target.streaming) {
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
