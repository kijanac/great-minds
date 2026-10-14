import type { replies } from "@great-minds/database";
import type { ReplySnapshot, SessionEvent, SessionExchangeEvent } from "@great-minds/domain";
import type { ConversationHistory } from "./history.ts";

export const projectSession = (history: ConversationHistory): readonly SessionEvent[] => [
  {
    type: "meta",
    id: history.header.session_id,
    query: history.turns[0]?.attempts[0]?.accepted.question ?? "",
    ts: new Date(history.header.created_at),
    user_id: history.header.author_id,
    origin: history.header.origin,
  },
  ...history.turns.flatMap((turn): SessionExchangeEvent[] => {
    const attempt = turn.attempts.at(-1);
    if (attempt === undefined) return [];
    const { accepted, settlement } = attempt;
    const timestamp = settlement === null ? accepted.accepted_at : settlement.settled_at;
    const sources = settlement?.sources ?? [];
    return [
      {
        type: "exchange",
        exId: turn.exchange_id,
        reply_id: accepted.reply_id,
        version: null,
        status: settlement?.outcome.status ?? "running",
        error: settlement?.outcome.status === "failed" ? settlement.outcome.message : null,
        query: accepted.question,
        thinking: sources.length === 0 ? [] : [{ sources }],
        answer: settlement?.answer ?? "",
        ts: timestamp === null ? null : new Date(timestamp),
      },
    ];
  }),
];

export const replySnapshot = (row: typeof replies.$inferSelect): ReplySnapshot => ({
  reply_id: row.id,
  session_id: row.sessionId,
  status: row.status,
  answer: row.answer,
  sources: row.sources,
  error: row.error,
  version: row.version,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
});

export type PublishedExchange = SessionExchangeEvent & {
  readonly status: "completed" | "stopped";
};

export const publicationExchanges = (
  events: readonly SessionEvent[],
): readonly PublishedExchange[] =>
  events.filter(
    (event): event is PublishedExchange =>
      event.type === "exchange" && (event.status === "completed" || event.status === "stopped"),
  );

export const renderSessionMarkdown = (exchanges: readonly PublishedExchange[]) => {
  const parts: string[] = [];
  for (const [index, exchange] of exchanges.entries()) {
    if (index > 0) parts.push("\n---\n\n");
    parts.push(`# ${exchange.query}\n\n`);
    if (exchange.status === "stopped") parts.push("> Response stopped.\n\n");
    for (const block of exchange.thinking) {
      for (const source of block.sources) parts.push(`> \`${source.label}\`\n`);
      parts.push(">\n");
    }
    parts.push(`${exchange.answer}\n`);
  }
  return `${parts.join("").replace(/\s+$/u, "")}\n`;
};
