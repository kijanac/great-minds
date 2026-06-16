import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

import { consumeStream, streamQuery } from "@/api/query";
import {
  appendBtw,
  appendExchange,
  createSession,
  type ExchangePayload,
  type SessionOrigin,
} from "@/api/sessions";
import type {
  BtwThread,
  Exchange,
  HistoryMessage,
  Phase,
  SelectionInfo,
  ThinkingBlock,
} from "@/lib/types";
import { buildBtwHistory, buildBtwQuery, genId, isAbortError } from "@/lib/utils";

function threadToHistory(thread: Exchange[]): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  for (const ex of thread) {
    history.push({ role: "user", content: ex.query });
    history.push({ role: "assistant", content: ex.answer });
  }
  return history;
}

function exchangeToPayload(ex: Exchange): ExchangePayload {
  return {
    id: ex.id,
    query: ex.query,
    thinking: ex.thinking,
    answer: ex.answer,
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
  // In-flight create promise: lets a rapid follow-up await the same create
  // instead of starting a second one. Idempotency key dedups create retries.
  const createRef = useRef<Promise<string> | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const threadRef = useRef(thread);
  const [liveThinking, setLiveThinking] = useState<ThinkingBlock[]>([]);
  const [liveText, setLiveText] = useState("");
  const [chips, setChips] = useState<string[]>([]);
  const [popover, setPopover] = useState<SelectionInfo | null>(null);

  const cleanupRef = useRef<(() => void)[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    threadRef.current = thread;
  }, [thread]);

  const runCleanup = useEffectEvent(() => {
    for (const fn of cleanupRef.current) fn();
  });

  useEffect(() => {
    return () => runCleanup();
  }, []);

  const originPathRef = useRef<string | undefined>(options?.originPath);
  const initialQueryRef = useRef<string | undefined>(options?.initialQuery);
  const onSessionCreatedRef = useRef(options?.onSessionCreated);
  const isFirstExchange = useRef(true);

  useEffect(() => {
    onSessionCreatedRef.current = options?.onSessionCreated;
  }, [options?.onSessionCreated]);

  // Persist an exchange: create the session on the first one (server mints the
  // id), append on the rest. Safe to call before a prior create resolves — the
  // second call awaits the same create promise rather than racing a duplicate.
  const persistExchange = useCallback(async (payload: ExchangePayload, origin?: SessionOrigin) => {
    try {
      if (!sessionIdRef.current && !createRef.current) {
        if (!idempotencyKeyRef.current) idempotencyKeyRef.current = crypto.randomUUID();
        createRef.current = createSession(payload, idempotencyKeyRef.current, origin).then(
          ({ id }) => {
            sessionIdRef.current = id;
            setSessionId(id);
            onSessionCreatedRef.current?.(id);
            return id;
          },
        );
        await createRef.current;
        return;
      }
      const id = sessionIdRef.current ?? (await createRef.current!);
      await appendExchange(id, payload);
    } catch (e) {
      // Create failed — clear so the next exchange retries; the stable
      // idempotency key makes a retry that actually committed return the same session.
      if (!sessionIdRef.current) createRef.current = null;
      console.error("Failed to persist session:", e);
    }
  }, []);

  const runExchange = useCallback(
    async (question: string) => {
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

        // Auto-persist session (fire-and-forget; the answer is already on screen)
        const payload = exchangeToPayload(exchange);
        const origin = originPathRef.current ? { doc_path: originPathRef.current } : undefined;
        void persistExchange(payload, origin);
      } catch (err) {
        if (isAbortError(err)) return;
        console.error("Query failed:", err);
        setPhase("idle");
      }
    },
    [persistExchange],
  );

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
      exchanges: [],
      pendingQuery: null,
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
    const priorExchanges = target?.exchanges ?? [];
    const isFirst = priorExchanges.length === 0;
    const ownerExId = target?.exchangeId ?? "";

    const updateBtw = (patch: Partial<BtwThread>) =>
      setThread((prev) =>
        prev.map((ex) => {
          if (ex.id !== ownerExId) return ex;
          return { ...ex, btws: ex.btws.map((b) => (b.id === btwId ? { ...b, ...patch } : b)) };
        }),
      );

    updateBtw({
      streaming: true,
      streamText: "",
      pendingQuery: userText,
      sources: [],
    });

    // First BTW turn: passage prefix on the question itself.
    // Follow-ups: passage prefix lives in turn 1 of priorExchanges (re-attached in buildBtwHistory).
    const question = isFirst ? buildBtwQuery(paragraph, anchor, userText) : userText;
    const history = [
      ...threadToHistory(threadRef.current),
      ...buildBtwHistory(priorExchanges, paragraph, anchor),
    ];

    const controller = new AbortController();
    cleanupRef.current.push(() => controller.abort());

    (async () => {
      try {
        const { answer, sources } = await consumeStream(
          streamQuery(question, { history, mode: "btw", signal: controller.signal }),
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
        const finalExchanges = [...priorExchanges, newExchange];
        updateBtw({
          streaming: false,
          streamText: "",
          pendingQuery: null,
          sources: [],
          exchanges: finalExchanges,
        });

        if (sessionIdRef.current) {
          appendBtw(sessionIdRef.current, {
            anchor,
            paragraph,
            exchangeId: ownerExId,
            paragraphIndex: target?.paragraphIndex ?? -1,
            exchanges: finalExchanges.map((ex) => ({
              query: ex.query,
              thinking: ex.thinking,
              answer: ex.answer,
            })),
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
        if (!target || target.exchanges.length > 0 || target.streaming) return ex;
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
