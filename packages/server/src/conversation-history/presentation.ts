import { citationsOf, type SessionExchange } from "@great-minds/domain";
import type { ConversationHistory } from "./history.ts";

export const projectSession = (history: ConversationHistory): readonly SessionExchange[] =>
  history.turns.map((turn) => {
    const { accepted, settlement } = turn.latest;
    const timestamp = settlement === null ? accepted.accepted_at : settlement.settled_at;
    return {
      exchange_id: turn.exchange_id,
      reply_id: accepted.reply_id,
      version: null,
      status: settlement?.outcome.status ?? "running",
      error: settlement?.outcome.status === "failed" ? settlement.outcome.message : null,
      query: accepted.question,
      sources: settlement?.sources ?? [],
      answer: settlement?.answer ?? "",
      citations: citationsOf(settlement?.answer ?? ""),
      ts: timestamp,
    };
  });

export type PublishedExchange = SessionExchange & {
  readonly status: "completed" | "stopped";
};

export const isPublished = (exchange: SessionExchange): exchange is PublishedExchange =>
  exchange.status === "completed" || exchange.status === "stopped";
