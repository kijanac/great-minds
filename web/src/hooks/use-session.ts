import { useCallback, useEffect, useRef, useState } from "react";

import { consumeStream, streamQuery } from "@/api/query";
import { appendBtw, appendExchange, createSession } from "@/api/sessions";
import type {
  BtwThread,
  Exchange,
  HistoryMessage,
  Phase,
  SelectionInfo,
  ThinkingBlock,
} from "@/lib/types";
import { assistantMsg, userMsg } from "@/lib/types";
import { buildBtwHistory, buildBtwQuery, genId, isAbortError } from "@/lib/utils";

function threadToHistory(thread: Exchange[]): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  for (const ex of thread) {
    history.push({ role: "user", content: ex.query });
    history.push({ role: "assistant", content: ex.answer });
  }
  return history;
}

function exchangeToPayload(ex: Exchange) {
  return {
    id: ex.id,
    query: ex.query,
    thinking: ex.thinking,
    answer: ex.answer,
    btws: ex.btws.map((b) => ({
      anchor: b.anchor,
      messages: b.messages,
    })),
  };
}

interface UseSessionOptions {
  initialExchanges?: Exchange[];
  sessionId?: string;
  originPath?: string;
  initialQuery?: string;
  onSessionCreated?: (sessionId: string) => void;
}

export function useSession(options?: UseSessionOptions) {
  const [phase, setPhase] = useState<Phase>(options?.initialExchanges?.length ? "done" : "idle");
  const [thread, setThread] = useState<Exchange[]>(options?.initialExchanges ?? []);
  const [sessionId, setSessionId] = useState<string | null>(options?.sessionId ?? null);
  const sessionIdRef = useRef<string | null>(options?.sessionId ?? null);
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const [liveThinking, setLiveThinking] = useState<ThinkingBlock[]>([]);
  const [liveText, setLiveText] = useState("");
  const [chips, setChips] = useState<string[]>([]);
  const [popover, setPopover] = useState<SelectionInfo | null>(null);

  const cleanupRef = useRef<(() => void)[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      for (const fn of cleanupRef.current) fn();
    };
  }, []);

  const originPathRef = useRef<string | undefined>(options?.originPath);
  const initialQueryRef = useRef<string | undefined>(options?.initialQuery);
  const onSessionCreatedRef = useRef(options?.onSessionCreated);
  onSessionCreatedRef.current = options?.onSessionCreated;
  const isFirstExchange = useRef(true);

  const runExchange = useCallback(async (question: string) => {
    const exId = genId("ex");
    setPhase("searching");
    setLiveThinking([]);
    setLiveText("");

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const originForQuery = isFirstExchange.current ? originPathRef.current : undefined;
      isFirstExchange.current = false;
      const history = threadToHistory(threadRef.current);
      const { answer, sources } = await consumeStream(
        streamQuery(question, {
          signal: controller.signal,
          originPath: originForQuery,
          history,
          mode: "query",
        }),
        {
          onSources: (s) => setLiveThinking([{ sources: s }]),
          onToken: (text) => {
            setPhase("streaming");
            setLiveText(text);
          },
        },
      );

      const exchange: Exchange = {
        id: exId,
        query: question,
        thinking: [{ sources }],
        answer,
        btws: [],
      };
      setThread((prev) => [...prev, exchange]);
      setLiveThinking([]);
      setLiveText("");
      setPhase("done");

      // Auto-persist session
      const payload = exchangeToPayload(exchange);
      if (!sessionIdRef.current) {
        const sid = genId("s");
        sessionIdRef.current = sid;
        createSession(sid, payload, originPathRef.current)
          .then(() => {
            setSessionId(sid);
            onSessionCreatedRef.current?.(sid);
          })
          .catch((e) => console.error("Failed to save session:", e));
      } else {
        appendExchange(sessionIdRef.current, payload).catch((e) =>
          console.error("Failed to append exchange:", e),
        );
      }
    } catch (err) {
      if (isAbortError(err)) return;
      console.error("Query failed:", err);
      setPhase("idle");
    }
  }, []);

  const submitQuery = useCallback(
    (question: string) => {
      if (phase !== "idle" && phase !== "done") return;
      runExchange(question);
    },
    [phase, runExchange],
  );

  const submitFollowUp = useCallback(
    (additionalText: string) => {
      const parts = [...chips.map((c) => `re: "${c}"`), additionalText].filter(Boolean);
      const question = parts.join(" — ");
      if (!question.trim()) return;
      setChips([]);
      runExchange(question);
    },
    [chips, runExchange],
  );

  const addChip = useCallback((text: string) => {
    setChips((prev) => [...prev, text]);
    setPopover(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const removeChip = useCallback((index: number) => {
    setChips((prev) => prev.filter((_, i) => i !== index));
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

    setThread((prev) =>
      prev.map((ex) => (ex.id === info.exchangeId ? { ...ex, btws: [...ex.btws, btw] } : ex)),
    );
    setPopover(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const replyBtw = useCallback((btwId: string, userText: string) => {
    const target = threadRef.current.flatMap((ex) => ex.btws).find((b) => b.id === btwId);
    const anchor = target?.anchor ?? "";
    const paragraph = target?.paragraph ?? "";
    const priorBtw = target?.messages ?? [];
    const isFirst = priorBtw.length === 0;

    const ownerExId = target?.exchangeId ?? "";

    setThread((prev) =>
      prev.map((ex) => {
        if (ex.id !== ownerExId) return ex;
        return {
          ...ex,
          btws: ex.btws.map((b) => {
            if (b.id !== btwId) return b;
            return {
              ...b,
              streaming: true,
              streamText: "",
              messages: [...b.messages, userMsg(userText)],
            };
          }),
        };
      }),
    );

    // First BTW turn: passage prefix on the question itself.
    // Follow-ups: passage prefix lives in turn 1 of priorBtw history (re-attached in buildBtwHistory).
    const question = isFirst ? buildBtwQuery(paragraph, anchor, userText) : userText;
    const history = [
      ...threadToHistory(threadRef.current),
      ...buildBtwHistory(priorBtw, paragraph, anchor),
    ];

    const controller = new AbortController();
    cleanupRef.current.push(() => controller.abort());

    const updateBtw = (patch: Partial<BtwThread>) =>
      setThread((prev) =>
        prev.map((ex) => {
          if (ex.id !== ownerExId) return ex;
          return { ...ex, btws: ex.btws.map((b) => (b.id === btwId ? { ...b, ...patch } : b)) };
        }),
      );

    (async () => {
      try {
        const { answer, sources } = await consumeStream(
          streamQuery(question, { history, mode: "btw", signal: controller.signal }),
          {
            onSources: (s) => updateBtw({ sources: s }),
            onToken: (text) => updateBtw({ streamText: text }),
          },
        );

        const finalMessages = [
          ...(target ? target.messages : []),
          userMsg(userText),
          assistantMsg(answer),
        ];
        updateBtw({ streaming: false, streamText: "", sources, messages: finalMessages });

        if (sessionIdRef.current) {
          appendBtw(sessionIdRef.current, {
            anchor,
            paragraph,
            exchangeId: ownerExId,
            paragraphIndex: target?.paragraphIndex ?? -1,
            messages: finalMessages,
          }).catch((e) => console.error("Failed to save btw:", e));
        }
      } catch (err) {
        if (isAbortError(err)) return;
      }
    })();
  }, []);

  const dismissBtw = useCallback((btwId: string) => {
    setThread((prev) =>
      prev.map((ex) => {
        const target = ex.btws.find((b) => b.id === btwId);
        if (!target || target.messages.length > 0 || target.streaming) return ex;
        return { ...ex, btws: ex.btws.filter((b) => b.id !== btwId) };
      }),
    );
  }, []);

  const handleSelection = useCallback((info: SelectionInfo | null) => {
    setPopover(info);
  }, []);

  const clearPopover = useCallback(() => {
    setPopover(null);
  }, []);

  // Auto-submit initial query (e.g. from article reader via URL params)
  useEffect(() => {
    if (initialQueryRef.current) {
      runExchange(initialQueryRef.current);
      initialQueryRef.current = undefined;
    }
  }, [runExchange]);

  return {
    sessionId,
    phase,
    thread,
    liveThinking,
    liveText,
    chips,
    popover,
    submitQuery,
    submitFollowUp,
    addChip,
    removeChip,
    startBtw,
    replyBtw,
    dismissBtw,
    handleSelection,
    clearPopover,
  };
}
