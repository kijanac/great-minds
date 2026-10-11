import {
  IsoDateTime,
  QueryRequest,
  ConversationKind,
  OriginScope,
  SessionOrigin,
  SessionId,
  SessionMetaEvent,
  ThinkingSource,
  Uuid,
  type SessionEvent,
} from "@great-minds/domain";
import { Effect, Schema } from "effect";
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { LlmMessageSchema } from "../../src/llm.ts";

export const sessions = pgTable("sessions", {
  id: text("id").$type<SessionId>().primaryKey(),
  vaultId: uuid("vault_id").$type<Uuid>().notNull(),
  userId: uuid("user_id").$type<Uuid>().notNull(),
  query: text("query").notNull(),
  origin: jsonb("origin"),
  kind: text("kind").$type<"session" | "btw">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  idempotencyKey: text("idempotency_key"),
});

export const replies = pgTable("replies", {
  id: uuid("id").$type<Uuid>().primaryKey(),
  vaultId: uuid("vault_id").$type<Uuid>().notNull(),
  userId: uuid("user_id").$type<Uuid>().notNull(),
  sessionId: text("session_id").$type<SessionId>().notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  stopRequested: boolean("stop_requested").notNull(),
  answer: text("answer").notNull(),
  sources: jsonb("sources").notNull(),
  error: text("error"),
  version: integer("version").notNull(),
  request: jsonb("request").notNull(),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  dispatchedTaskId: uuid("dispatched_task_id").$type<Uuid>(),
  generationCursor: integer("generation_cursor").notNull(),
  activeGenerationStep: integer("active_generation_step"),
  activeGenerationKind: text("active_generation_kind"),
  activeGenerationKey: text("active_generation_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const CreateReplyRequest = Schema.Struct({
  ...QueryRequest.fields,
  reply_id: Uuid,
  exchange_id: Uuid,
  session: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("new"),
      idempotency_key: Schema.String,
      conversation_kind: ConversationKind.pipe(
        Schema.withDecodingDefaultTypeKey(Effect.succeed("session" as const)),
      ),
      origin_scope: OriginScope.pipe(
        Schema.withDecodingDefaultTypeKey(Effect.succeed("vault" as const)),
      ),
      origin: Schema.optionalKey(SessionOrigin),
    }),
    Schema.Struct({ kind: Schema.Literal("existing"), id: SessionId }),
  ]),
});

export const StoredSessionMeta = Schema.Struct({
  ...SessionMetaEvent.fields,
  context: Schema.optionalKey(Schema.Struct({ session_id: SessionId, reply_id: Uuid })),
});
export type StoredSessionMeta = typeof StoredSessionMeta.Type;

export const ReplyNode = Schema.Struct({
  type: Schema.Literal("reply"),
  reply_id: Uuid,
  parent_reply_id: Schema.NullOr(Uuid),
  exchange_id: Uuid,
  question: Schema.String,
  status: Schema.Literals(["pending", "completed", "stopped"]),
  messages: Schema.Array(LlmMessageSchema),
  sources: Schema.Array(ThinkingSource),
  answer: Schema.String,
  ts: IsoDateTime,
});
export type ReplyNode = typeof ReplyNode.Type;

export const StoredSessionEvent = Schema.Union([StoredSessionMeta, ReplyNode]);
export type StoredSessionEvent = typeof StoredSessionEvent.Type;

export const currentNodes = (events: readonly StoredSessionEvent[]): readonly ReplyNode[] => {
  const latest = new Map<Uuid, ReplyNode>();
  for (const event of events) {
    if (event.type === "reply") latest.set(event.exchange_id, event);
  }
  return [...latest.values()];
};

export const parentReplyIdFor = (nodes: readonly ReplyNode[]): Uuid | null =>
  nodes.findLast((node) => node.status !== "pending")?.reply_id ?? null;

export const projectSession = (events: readonly StoredSessionEvent[]): SessionEvent[] => [
  ...events.filter((event) => event.type === "meta"),
  ...currentNodes(events).map((node) => ({
    type: "exchange" as const,
    exId: node.exchange_id,
    reply_id: node.reply_id,
    status: node.status === "pending" ? ("running" as const) : node.status,
    error: null,
    query: node.question,
    thinking: node.sources.length === 0 ? [] : [{ sources: node.sources }],
    answer: node.answer,
    ts: node.ts,
  })),
];

export const renderSessionMarkdown = (events: readonly SessionEvent[]) => {
  const parts: string[] = [];
  for (const [index, exchange] of events.filter((event) => event.type === "exchange").entries()) {
    if (index > 0) parts.push("\n---\n\n");
    parts.push(`# ${exchange.query}\n\n`);
    for (const block of exchange.thinking) {
      for (const source of block.sources) parts.push(`> \`${source.label}\`\n`);
      parts.push(">\n");
    }
    parts.push(`${exchange.answer}\n`);
  }
  return `${parts.join("").replace(/\s+$/u, "")}\n`;
};
