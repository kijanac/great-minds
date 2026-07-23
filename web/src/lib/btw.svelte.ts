import { consumeStream, streamQuery } from "$lib/api/query";
import { appendExchange, createSession, type ExchangePayload } from "$lib/api/sessions";
import type { BtwThread, Exchange, SelectionInfo } from "$lib/types";
import { buildBtwHistory, buildBtwQuery, genId, isAbortError } from "$lib/utils";

export class EphemeralBtws {
  btws = $state<BtwThread[]>([]);
  #controllers = new Set<AbortController>();

  constructor(
    private readonly originPath: string,
    private readonly onSpunOff: (sessionId: string) => void,
  ) {}

  destroy = (): void => {
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    this.btws = [];
  };

  startBtw = (info: SelectionInfo): void => {
    this.btws = [
      ...this.btws,
      {
        id: genId("btw"),
        exchangeId: info.exchangeId,
        anchor: {
          blockOffset: info.blockOffset,
          quote: info.quote,
          context: info.context,
        },
        exchanges: [],
      },
    ];
  };

  replyBtw = (btwId: string, userText: string): void => {
    const target = this.btws.find((btw) => btw.id === btwId);
    const anchor = target?.anchor ?? {
      blockOffset: -1,
      quote: "",
      context: "",
    };
    const priorExchanges = target?.exchanges ?? [];
    const isFirst = priorExchanges.length === 0;
    const turnId = genId("ex");

    const patchExchanges = (mutate: (exchanges: Exchange[]) => Exchange[]): void => {
      this.btws = this.btws.map((btw) =>
        btw.id === btwId ? { ...btw, exchanges: mutate(btw.exchanges) } : btw,
      );
    };
    const patchTurn = (patch: Partial<Exchange>): void =>
      patchExchanges((exchanges) =>
        exchanges.map((exchange) =>
          exchange.id === turnId ? { ...exchange, ...patch } : exchange,
        ),
      );

    patchExchanges((exchanges) => [
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
    const history = buildBtwHistory(priorExchanges, anchor);
    const controller = new AbortController();
    this.#controllers.add(controller);

    void (async () => {
      try {
        const { answer, sources } = await consumeStream(
          streamQuery(question, {
            originPath: this.originPath,
            history,
            mode: "btw",
            signal: controller.signal,
          }),
          {
            onSources: (nextSources) => patchTurn({ thinking: [{ sources: nextSources }] }),
            onToken: (text) => patchTurn({ answer: text }),
          },
        );
        patchTurn({
          thinking: sources.length > 0 ? [{ sources }] : [],
          answer,
          streaming: false,
        });
      } catch (error) {
        if (isAbortError(error)) return;
        patchExchanges((exchanges) => exchanges.filter((exchange) => exchange.id !== turnId));
      } finally {
        this.#controllers.delete(controller);
      }
    })();
  };

  spinOff = async (btwId: string): Promise<void> => {
    const target = this.btws.find((btw) => btw.id === btwId);
    if (
      !target ||
      target.exchanges.some((exchange) => exchange.streaming) ||
      target.exchanges.length === 0
    ) {
      return;
    }

    try {
      const { id } = await createSession(
        target.exchanges[0] as ExchangePayload,
        crypto.randomUUID(),
        {
          doc_path: this.originPath,
          anchor: target.anchor.quote,
        },
      );
      for (let index = 1; index < target.exchanges.length; index++) {
        await appendExchange(id, target.exchanges[index] as ExchangePayload);
      }
      this.btws = this.btws.filter((btw) => btw.id !== btwId);
      this.onSpunOff(id);
    } catch (error) {
      console.error("Failed to spin off BTW:", error);
    }
  };

  dismissEmpty = (btwId: string): void => {
    const target = this.btws.find((btw) => btw.id === btwId);
    if (target?.exchanges.length === 0) {
      this.btws = this.btws.filter((btw) => btw.id !== btwId);
    }
  };
}
