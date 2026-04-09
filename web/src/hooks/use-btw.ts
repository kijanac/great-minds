import { useCallback, useEffect, useRef, useState } from "react";

import { consumeStream, streamQuery } from "@/api/query";
import type { BtwThread, SelectionInfo } from "@/lib/types";
import { assistantMsg, userMsg } from "@/lib/types";
import { buildBtwQuery, genId, isAbortError } from "@/lib/utils";

export function useBtw(originPath?: string) {
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
      messages: [],
      sources: [],
      streaming: false,
      streamText: "",
    };
    setBtws((prev) => [...prev, btw]);
  }, []);

  const replyBtw = useCallback((btwId: string, userText: string) => {
    const target = btwsRef.current.find((b) => b.id === btwId);
    const anchor = target?.anchor ?? "";
    const paragraph = target?.paragraph ?? "";

    setBtws((prev) =>
      prev.map((b) => {
        if (b.id !== btwId) return b;
        return {
          ...b,
          streaming: true,
          streamText: "",
          messages: [...b.messages, userMsg(userText)],
        };
      }),
    );

    const contextualQuery = buildBtwQuery(paragraph, anchor, userText);

    const controller = new AbortController();
    cleanupRef.current.push(() => controller.abort());

    const updateBtw = (patch: Partial<BtwThread>) =>
      setBtws((prev) => prev.map((b) => (b.id === btwId ? { ...b, ...patch } : b)));

    (async () => {
      try {
        const { answer, sources } = await consumeStream(
          streamQuery(contextualQuery, { originPath, mode: "btw", signal: controller.signal }),
          {
            onSources: (s) => updateBtw({ sources: s }),
            onToken: (text) => updateBtw({ streamText: text }),
          },
        );

        updateBtw({
          streaming: false,
          streamText: "",
          sources,
          messages: [...(target?.messages ?? []), userMsg(userText), assistantMsg(answer)],
        });
      } catch (err) {
        if (isAbortError(err)) return;
      }
    })();
  }, []);

  const dismissEmpty = useCallback((btwId: string) => {
    setBtws((prev) => {
      const target = prev.find((b) => b.id === btwId);
      if (target && target.messages.length === 0 && !target.streaming) {
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

  return { btws, startBtw, replyBtw, dismissEmpty, cleanup };
}
