import { browser } from "$app/environment";

import { consumeStream, streamQuery } from "$lib/api/query";
import {
  appendBtw,
  appendExchange,
  createSession,
  type ExchangePayload,
  type SessionOrigin,
} from "$lib/api/sessions";
import type { BtwThread, Exchange, HistoryMessage, Phase, SelectionInfo } from "$lib/types";
import { buildBtwHistory, buildBtwQuery, genId, isAbortError } from "$lib/utils";

function threadToHistory(thread: Exchange[]): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  for (const exchange of thread) {
    history.push({ role: "user", content: exchange.query });
    history.push({ role: "assistant", content: exchange.answer });
  }
  return history;
}

export interface SessionOptions {
  initialExchanges?: Exchange[];
  sessionId?: string;
  originPath?: string;
  initialQuery?: string;
  onSessionCreated?: (sessionId: string) => void;
}

export class Session {
  phase = $state<Phase>("idle");
  thread = $state<Exchange[]>([]);
  sessionId = $state<string | null>(null);
  chips = $state<string[]>([]);
  popover = $state<SelectionInfo | null>(null);

  #originPath: string | undefined;
  #onSessionCreated: ((sessionId: string) => void) | undefined;
  #createPromise: Promise<string> | null = null;
  #idempotencyKey: string | null = null;
  #abortController: AbortController | null = null;
  #btwControllers = new Set<AbortController>();
  #isFirstExchange = true;
  #destroyed = false;

  constructor(options: SessionOptions = {}) {
    this.phase = options.initialExchanges?.length ? "done" : "idle";
    this.thread = options.initialExchanges ?? [];
    this.sessionId = options.sessionId ?? null;
    this.#originPath = options.originPath;
    this.#onSessionCreated = options.onSessionCreated;

    if (browser && options.initialQuery) {
      const initialQuery = options.initialQuery;
      queueMicrotask(() => {
        if (!this.#destroyed) void this.#runExchange(initialQuery);
      });
    }
  }

  destroy = (): void => {
    this.#destroyed = true;
    this.#abortController?.abort();
    for (const controller of this.#btwControllers) controller.abort();
    this.#btwControllers.clear();
  };

  #persistExchange = async (payload: ExchangePayload, origin?: SessionOrigin): Promise<void> => {
    try {
      if (!this.sessionId && !this.#createPromise) {
        this.#idempotencyKey ??= crypto.randomUUID();
        this.#createPromise = createSession(payload, this.#idempotencyKey, origin).then(
          ({ id }) => {
            this.sessionId = id;
            this.#onSessionCreated?.(id);
            return id;
          },
        );
        await this.#createPromise;
        return;
      }

      const id = this.sessionId ?? (await this.#createPromise!);
      await appendExchange(id, payload);
    } catch (error) {
      if (!this.sessionId) this.#createPromise = null;
      console.error("Failed to persist session:", error);
    }
  };

  #updateExchange = (id: string, patch: Partial<Exchange>): void => {
    this.thread = this.thread.map((exchange) =>
      exchange.id === id ? { ...exchange, ...patch } : exchange,
    );
  };

  #runExchange = async (question: string): Promise<void> => {
    const exchangeId = genId("ex");
    this.phase = "searching";

    const originForQuery = this.#isFirstExchange ? this.#originPath : undefined;
    this.#isFirstExchange = false;
    const history = threadToHistory(this.thread);

    this.thread = [
      ...this.thread,
      {
        id: exchangeId,
        query: question,
        thinking: [],
        answer: "",
        btws: [],
        streaming: true,
      },
    ];

    this.#abortController?.abort();
    const controller = new AbortController();
    this.#abortController = controller;

    try {
      const { answer, sources } = await consumeStream(
        streamQuery(question, {
          signal: controller.signal,
          originPath: originForQuery,
          history,
          mode: "query",
        }),
        {
          onSources: (nextSources) =>
            this.#updateExchange(exchangeId, {
              thinking: [{ sources: nextSources }],
            }),
          onToken: (text) => {
            this.phase = "streaming";
            this.#updateExchange(exchangeId, { answer: text });
          },
        },
      );

      this.#updateExchange(exchangeId, {
        thinking: [{ sources }],
        answer,
        streaming: false,
      });
      this.phase = "done";

      const payload: ExchangePayload = {
        id: exchangeId,
        query: question,
        thinking: [{ sources }],
        answer,
      };
      const origin = this.#originPath ? { doc_path: this.#originPath } : undefined;
      void this.#persistExchange(payload, origin);
    } catch (error) {
      this.thread = this.thread.filter((exchange) => exchange.id !== exchangeId);
      if (isAbortError(error)) return;
      console.error("Query failed:", error);
      this.phase = "idle";
    }
  };

  submitQuery = (question: string): void => {
    if (this.phase !== "idle" && this.phase !== "done") return;
    void this.#runExchange(question);
  };

  submitFollowUp = (additionalText: string): void => {
    const parts = [...this.chips.map((chip) => `re: "${chip}"`), additionalText].filter(Boolean);
    const question = parts.join(" — ");
    if (!question.trim()) return;
    this.chips = [];
    void this.#runExchange(question);
  };

  addChip = (text: string): void => {
    this.chips = [...this.chips, text];
    this.popover = null;
    window.getSelection()?.removeAllRanges();
  };

  removeChip = (index: number): void => {
    this.chips = this.chips.filter((_, itemIndex) => itemIndex !== index);
  };

  startBtw = (info: SelectionInfo): void => {
    const btw: BtwThread = {
      id: genId("btw"),
      exchangeId: info.exchangeId,
      anchor: {
        blockOffset: info.blockOffset,
        quote: info.quote,
        context: info.context,
      },
      exchanges: [],
    };

    this.thread = this.thread.map((exchange) =>
      exchange.id === info.exchangeId ? { ...exchange, btws: [...exchange.btws, btw] } : exchange,
    );
    this.popover = null;
    window.getSelection()?.removeAllRanges();
  };

  replyBtw = (btwId: string, userText: string): void => {
    const target = this.thread.flatMap((exchange) => exchange.btws).find((btw) => btw.id === btwId);
    const anchor = target?.anchor ?? {
      blockOffset: -1,
      quote: "",
      context: "",
    };
    const priorExchanges = target?.exchanges ?? [];
    const isFirst = priorExchanges.length === 0;
    const ownerExchangeId = target?.exchangeId ?? "";
    const turnId = genId("ex");

    // History must exclude the optimistic turn added below.
    const baseHistory = threadToHistory(this.thread);

    const patchBtwExchanges = (mutate: (exchanges: Exchange[]) => Exchange[]): void => {
      this.thread = this.thread.map((exchange) =>
        exchange.id !== ownerExchangeId
          ? exchange
          : {
              ...exchange,
              btws: exchange.btws.map((btw) =>
                btw.id === btwId ? { ...btw, exchanges: mutate(btw.exchanges) } : btw,
              ),
            },
      );
    };
    const patchTurn = (patch: Partial<Exchange>): void =>
      patchBtwExchanges((exchanges) =>
        exchanges.map((exchange) =>
          exchange.id === turnId ? { ...exchange, ...patch } : exchange,
        ),
      );

    patchBtwExchanges((exchanges) => [
      ...exchanges,
      {
        id: turnId,
        query: userText,
        thinking: [],
        answer: "",
        btws: [],
        streaming: true,
      },
    ]);

    const question = isFirst ? buildBtwQuery(anchor, userText) : userText;
    const history = [...baseHistory, ...buildBtwHistory(priorExchanges, anchor)];
    const controller = new AbortController();
    this.#btwControllers.add(controller);

    // Reload mid-stream must not lose the turn; completion append supersedes.
    if (this.sessionId) {
      appendBtw(this.sessionId, {
        quote: anchor.quote,
        blockOffset: anchor.blockOffset,
        context: anchor.context,
        exchangeId: ownerExchangeId,
        exchanges: [...priorExchanges, { query: userText, thinking: [], answer: "" }].map(
          (exchange) => ({
            query: exchange.query,
            thinking: exchange.thinking,
            answer: exchange.answer,
          }),
        ),
      }).catch((error) => console.warn("Failed to persist pending btw:", error));
    }

    void (async () => {
      try {
        const { answer, sources } = await consumeStream(
          streamQuery(question, {
            history,
            mode: "btw",
            signal: controller.signal,
          }),
          {
            onSources: (nextSources) => patchTurn({ thinking: [{ sources: nextSources }] }),
            onToken: (text) => patchTurn({ answer: text }),
          },
        );

        const thinking = sources.length > 0 ? [{ sources }] : [];
        patchTurn({ thinking, answer, streaming: false });

        if (this.sessionId) {
          const finalExchanges = [
            ...priorExchanges,
            {
              id: turnId,
              query: userText,
              thinking,
              answer,
              btws: [],
              streaming: false,
            },
          ];
          appendBtw(this.sessionId, {
            quote: anchor.quote,
            blockOffset: anchor.blockOffset,
            context: anchor.context,
            exchangeId: ownerExchangeId,
            exchanges: finalExchanges.map((exchange) => ({
              query: exchange.query,
              thinking: exchange.thinking,
              answer: exchange.answer,
            })),
          }).catch((error) => console.error("Failed to save btw:", error));
        }
      } catch (error) {
        if (isAbortError(error)) return;
        patchBtwExchanges((exchanges) => exchanges.filter((exchange) => exchange.id !== turnId));
      } finally {
        this.#btwControllers.delete(controller);
      }
    })();
  };

  dismissBtw = (btwId: string): void => {
    this.thread = this.thread.map((exchange) => {
      const target = exchange.btws.find((btw) => btw.id === btwId);
      if (!target || target.exchanges.length > 0) return exchange;
      return {
        ...exchange,
        btws: exchange.btws.filter((btw) => btw.id !== btwId),
      };
    });
  };

  handleSelection = (info: SelectionInfo | null): void => {
    this.popover = info;
  };

  clearPopover = (): void => {
    this.popover = null;
  };
}
