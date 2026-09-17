import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Database, replies, sessions } from "@great-minds/database";
import {
  composeAnchoredQuestion,
  CreateReplyRequest,
  IsoDateTime,
  ReplySource,
  type ConversationKind,
  SessionId,
  ThinkingBlock as ThinkingBlockSchema,
  type SessionOrigin,
  Uuid,
} from "@great-minds/domain";
import { and, eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";

import { AppConfigLive } from "../src/config.ts";
import { DrizzleLive } from "../src/db.ts";
import { StructuredLoggerLive } from "../src/logging.ts";
import {
  parentReplyIdFor,
  projectSession,
  renderSessionMarkdown,
  ReplyNode,
  StoredSessionMeta,
  StoredSessionEvent as ConversationEvent,
} from "../src/sessions.ts";
import { sourceIdForKey } from "../src/source-identity.ts";
import { StorageServicesLive, ContentStorage, vaultOwner } from "../src/storage.ts";

const decodeMetaEvent = Schema.decodeUnknownSync(StoredSessionMeta);
const LegacyReplyNode = Schema.Struct({
  ...ReplyNode.fields,
  btw: Schema.optionalKey(Schema.Struct({
    exchange_id: Uuid,
    quote: Schema.String,
    block_offset: Schema.Number,
    context: Schema.String,
  })),
});
type LegacyReplyNode = typeof LegacyReplyNode.Type;
const StoredSessionEvent = Schema.Union([StoredSessionMeta, LegacyReplyNode]);
type StoredSessionEvent = typeof StoredSessionEvent.Type;
const decodeReplyNode = Schema.decodeUnknownSync(LegacyReplyNode);
const encodeStoredEvent = Schema.encodeSync(ConversationEvent);

export const LegacyReplySource = Schema.Struct({
  ...ReplySource.fields,
  document_id: ReplySource.fields.document_id.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(null))),
});
const LegacyThinkingBlock = Schema.Struct({
  sources: Schema.Array(LegacyReplySource).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
});

const LegacyBtwExchange = Schema.Struct({
  query: Schema.String,
  thinking: Schema.optionalKey(Schema.Array(LegacyThinkingBlock)),
  answer: Schema.optionalKey(Schema.String),
});

const LegacyExchangeEvent = Schema.Struct({
  type: Schema.Literal("exchange"),
  exId: Schema.String,
  reply_id: Schema.optionalKey(Uuid),
  query: Schema.String,
  thinking: Schema.optionalKey(Schema.Array(LegacyThinkingBlock)),
  answer: Schema.optionalKey(Schema.String),
  ts: IsoDateTime,
});
type LegacyExchangeEvent = typeof LegacyExchangeEvent.Type;
const decodeExchangeEvent = Schema.decodeUnknownSync(LegacyExchangeEvent);

const LegacyBtwEvent = Schema.Struct({
  type: Schema.Literal("btw"),
  exId: Schema.String,
  reply_id: Schema.optionalKey(Uuid),
  quote: Schema.String,
  blockOffset: Schema.optionalKey(Schema.Number),
  context: Schema.optionalKey(Schema.String),
  exchanges: Schema.Array(LegacyBtwExchange),
  ts: IsoDateTime,
});
type LegacyBtwEvent = typeof LegacyBtwEvent.Type;

const decodeBtwEvent = Schema.decodeUnknownSync(LegacyBtwEvent);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sourcesOf = (thinking: readonly (typeof ThinkingBlockSchema)["Type"][] | undefined) =>
  thinking?.flatMap((block) => block.sources ?? []) ?? [];

const composedFor = (
  anchor: { readonly quote: string | null; readonly context: string | null } | null,
  question: string,
) =>
  anchor !== null && anchor.quote !== null && anchor.quote !== undefined
    ? composeAnchoredQuestion(anchor, question)
    : question;

export const convertLegacySession = (
  lines: readonly unknown[],
  mintId: () => Uuid,
  exchangeIds = new Map<string, Uuid>(),
): StoredSessionEvent[] => {
  const metas: StoredSessionMeta[] = [];
  const replies: LegacyReplyNode[] = [];
  const exchanges: LegacyExchangeEvent[] = [];
  const btws: LegacyBtwEvent[] = [];
  for (const raw of lines) {
    if (!isRecord(raw)) {
      continue;
    }
    if (raw.type === "meta") {
      const origin = isRecord(raw.origin) && raw.origin.kind === undefined
        ? { ...raw.origin, kind: "document" }
        : raw.origin;
      metas.push(decodeMetaEvent({ ...raw, origin }));
      continue;
    }
    if (raw.type === "reply") {
      replies.push(decodeReplyNode(raw));
      continue;
    }
    if (raw.type === "exchange") {
      exchanges.push(decodeExchangeEvent(raw));
      continue;
    }
    if (raw.type === "btw") {
      btws.push(decodeBtwEvent(raw));
      continue;
    }
  }
  if (replies.length > 0) {
    return [...metas, ...replies];
  }

  const meta = metas[0];
  const origin: SessionOrigin | null = meta?.origin ?? null;
  const rootAnchor =
    origin === null || origin.anchor === undefined || origin.anchor === null
      ? null
      : { quote: origin.anchor, context: origin.paragraph };

  const exchangeEvents = new Map<string, LegacyExchangeEvent>();
  for (const event of exchanges) {
    exchangeEvents.set(event.exId, event);
  }

  // Legacy on-disk exchange ids are NOT uuids (they look like `ex-<uuid>`).
  // Mint a fresh uuid for each distinct legacy id and remember the mapping so
  // BTW anchors point at the new id of their owning main-line exchange.
  const exchangeIdFor = (exId: string): Uuid => {
    const existing = exchangeIds.get(exId);
    if (existing !== undefined) {
      return existing;
    }
    const minted = mintId();
    exchangeIds.set(exId, minted);
    return minted;
  };

  const mainLine: ReplyNode[] = [];
  let previousReplyId: Uuid | null = null;
  for (const [exId, event] of exchangeEvents) {
    const answer = event.answer ?? "";
    const isPending = answer.length === 0;
    const firstNode = mainLine.length === 0;
    const question = isPending
      ? ""
      : firstNode
        ? composedFor(rootAnchor, event.query)
        : event.query;
    const replyId = event.reply_id ?? mintId();
    const node: ReplyNode = {
      type: "reply",
      reply_id: replyId,
      parent_reply_id: previousReplyId,
      exchange_id: exchangeIdFor(exId),
      question: event.query,
      status: isPending ? "pending" : "completed",
      messages: isPending
        ? []
        : [
            { role: "user", content: question },
            { role: "assistant", content: answer },
          ],
      sources: sourcesOf(event.thinking),
      answer,
      ts: event.ts,
    };
    mainLine.push(node);
    previousReplyId = replyId;
  }

  const btwEvents = new Map<string, LegacyBtwEvent>();
  const btwStartedAt = new Map<string, Date>();
  for (const event of btws) {
    const key = `${event.exId}\0${event.quote}`;
    btwEvents.set(key, event);
    if (!btwStartedAt.has(key)) btwStartedAt.set(key, event.ts);
  }

  const output: StoredSessionEvent[] = [...metas, ...mainLine];
  for (const [key, event] of btwEvents) {
    const context = event.context ?? "";
    const startedAt = btwStartedAt.get(key)!;
    const mainAtStart = mainLine.filter((node) => node.ts.getTime() <= startedAt.getTime());
    let parentReplyId = parentReplyIdFor(mainAtStart);
    for (const [index, exchange] of event.exchanges.entries()) {
      const isLast = index === event.exchanges.length - 1;
      const replyId = isLast && event.reply_id !== undefined ? event.reply_id : mintId();
      const answer = exchange.answer ?? "";
      const isPending = answer.length === 0;
      const question = isPending
        ? ""
        : index === 0
          ? composeAnchoredQuestion({ quote: event.quote, context }, exchange.query)
          : exchange.query;
      const node: LegacyReplyNode = {
        type: "reply",
        reply_id: replyId,
        parent_reply_id: parentReplyId,
        exchange_id: mintId(),
        btw: {
          exchange_id: exchangeIdFor(event.exId),
          quote: event.quote,
          block_offset: event.blockOffset ?? -1,
          context,
        },
        question: exchange.query,
        status: isPending ? "pending" : "completed",
        messages: isPending
          ? []
          : [
              { role: "user", content: question },
              { role: "assistant", content: answer },
            ],
        sources: sourcesOf(exchange.thinking),
        answer,
        ts: index === 0 ? startedAt : event.ts,
      };
      output.push(node);
      parentReplyId = replyId;
    }
  }
  return output;
};

const sessionPath = (sessionId: string, extension: "jsonl" | "md") =>
  `sessions/${sessionId}.${extension}`;

export type ConversationConversion = {
  readonly id: SessionId;
  readonly kind: ConversationKind;
  readonly origin: SessionOrigin | null;
  readonly events: readonly ConversationEvent[];
};

export const splitSessionConversations = (
  events: readonly StoredSessionEvent[],
  vaultId: Uuid,
  kind: ConversationKind,
): readonly ConversationConversion[] => {
  const meta = events.find((event) => event.type === "meta");
  if (meta === undefined) throw new Error("Session metadata is missing");
  const nodes = events.filter((event) => event.type === "reply");
  const main = nodes.filter((node) => node.btw === undefined);
  const groups = new Map<string, LegacyReplyNode[]>();
  for (const node of nodes) {
    if (node.btw === undefined) continue;
    const key = `${node.btw.exchange_id}\0${node.btw.quote}`;
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  if (kind === "btw" && groups.size > 0) {
    throw new Error(`Session ${meta.id} contains historical nested BTWs; review before migrating`);
  }
  const output: ConversationConversion[] = [{ id: meta.id, kind, origin: meta.origin, events: [meta, ...main] }];
  for (const [key, thread] of groups) {
    const first = thread[0]!;
    const anchor = first.btw!;
    if (!main.some((node) => node.exchange_id === anchor.exchange_id)) {
      throw new Error(`Session ${meta.id} has a BTW with a missing answer anchor`);
    }
    if (first.parent_reply_id !== null && !main.some((node) => node.reply_id === first.parent_reply_id)) {
      throw new Error(`Session ${meta.id} has a BTW with missing inherited context`);
    }
    const id = SessionId.make(sourceIdForKey(vaultId, `btw:${meta.id}:${key}`));
    const origin: SessionOrigin = {
      kind: "answer",
      session_id: meta.id,
      exchange_id: anchor.exchange_id,
      anchor: anchor.quote,
      paragraph: anchor.context,
      paragraph_index: anchor.block_offset,
    };
    const replyIds = new Set(thread.map((node) => node.reply_id));
    const ownNodes: ReplyNode[] = thread.map(({ btw: _btw, ...node }) => ({
      ...node,
      parent_reply_id: node.parent_reply_id !== null && replyIds.has(node.parent_reply_id)
        ? node.parent_reply_id
        : null,
    }));
    const childMeta: StoredSessionMeta = {
      type: "meta",
      id,
      query: first.question,
      ts: first.ts,
      user_id: meta.user_id,
      origin,
      ...(first.parent_reply_id === null ? {} : {
        context: { session_id: meta.id, reply_id: first.parent_reply_id },
      }),
    };
    output.push({ id, kind: "btw", origin, events: [childMeta, ...ownNodes] });
  }
  return output;
};

const main = async () => {
  const apply = process.argv.includes("--apply");
  const ConfigLive = AppConfigLive;
  const DatabaseLive = DrizzleLive.pipe(Layer.provideMerge(ConfigLive));
  const BaseLive = Layer.mergeAll(DatabaseLive, StructuredLoggerLive);
  const StorageLive = StorageServicesLive.pipe(Layer.provideMerge(BaseLive));
  const runtime = ManagedRuntime.make(StorageLive);
  try {
    const counts = await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const storage = yield* ContentStorage;
      const rows = yield* db.query((d) => d.select().from(sessions));
      const replyRows = yield* db.query((d) => d.select().from(replies));
      if (apply && replyRows.some((row) => row.status === "running")) {
        throw new Error("Stop reply generation before applying the conversation migration");
      }
      const plans: {
        row: typeof sessions.$inferSelect;
        original: string;
        markdown: string | null;
        conversions: readonly ConversationConversion[];
        updates: { id: Uuid; sessionId: SessionId; request: typeof CreateReplyRequest.Type; sources: readonly (typeof ReplySource.Type)[] }[];
      }[] = [];
      const decodeRequest = Schema.decodeUnknownSync(CreateReplyRequest);
      for (const row of rows) {
        const owner = vaultOwner(row.vaultId);
        const backupPath = `migrations/btw-conversations/${row.id}`;
        const backup = yield* Effect.result(storage.readText(owner, `${backupPath}/session.jsonl`));
        const read = yield* Effect.result(
          storage.readText(vaultOwner(row.vaultId), sessionPath(row.id, "jsonl")),
        );
        if (read._tag === "Failure") {
          throw new Error(`Session ${row.id} has no JSONL file`);
        }
        const original = backup._tag === "Success" ? backup.success : read.success;
        const parsed = original
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as unknown);
        const latestMeta = parsed.findLastIndex((line) => isRecord(line) && line.type === "meta");
        if (latestMeta < 0) throw new Error(`Session ${row.id} has no metadata`);
        const active = parsed.slice(latestMeta);
        if (active.some((line) => !isRecord(line) || !["meta", "reply", "exchange", "btw"].includes(String(line.type)))) {
          throw new Error(`Session ${row.id} contains an unknown event`);
        }
        let sequence = 0;
        const exchangeIds = new Map<string, Uuid>();
        const legacy = convertLegacySession(active, () => sourceIdForKey(row.vaultId, `session-migration:${row.id}:${sequence++}`), exchangeIds);
        const conversions = splitSessionConversations(legacy, row.vaultId, row.kind);
        if (conversions[0]?.id !== row.id) throw new Error(`Session ${row.id} metadata has a different identity`);
        const encoded = conversions[0].events.map((event) => `${JSON.stringify(encodeStoredEvent(event))}\n`).join("");
        if (read.success !== original && read.success !== encoded) {
          throw new Error(`Session ${row.id} changed after its migration backup`);
        }
        const markdown = yield* Effect.result(storage.readText(owner, sessionPath(row.id, "md")));
        const updates: (typeof plans)[number]["updates"] = [];
        for (const reply of replyRows.filter((reply) => reply.sessionId === row.id && reply.vaultId === row.vaultId)) {
          if (!isRecord(reply.request)) throw new Error(`Reply ${reply.id} has an invalid saved request`);
          const candidates = conversions.flatMap((conversation) => conversation.events
            .filter((event) => event.type === "reply" && event.reply_id === reply.id)
            .map((event) => ({ conversation, event })));
          const target = candidates.at(-1);
          if (target === undefined || target.event.type !== "reply") {
            throw new Error(`Reply ${reply.id} cannot be matched to its saved turn; review before migrating`);
          }
          updates.push({
            id: reply.id,
            sessionId: target.conversation.id,
            sources: Schema.decodeUnknownSync(Schema.Array(LegacyReplySource))(reply.sources),
            request: decodeRequest({
              ...reply.request,
              reply_id: reply.id,
              exchange_id: target.event.exchange_id,
              session: { kind: "existing", id: target.conversation.id },
            }),
          });
        }
        for (const conversation of conversions.slice(1)) {
          const current = yield* Effect.result(storage.readText(owner, sessionPath(conversation.id, "jsonl")));
          const expected = conversation.events.map((event) => `${JSON.stringify(encodeStoredEvent(event))}\n`).join("");
          if (current._tag === "Success" && current.success !== expected) {
            throw new Error(`Destination conversation ${conversation.id} already contains different history`);
          }
        }
        plans.push({ row, original, markdown: markdown._tag === "Success" ? markdown.success : null, conversions, updates });
      }
      const summary = {
        mode: apply ? "applied" : "preview",
        sessions: plans.length,
        answerBtws: plans.reduce((total, plan) => total + plan.conversions.length - 1, 0),
        replies: plans.reduce((total, plan) => total + plan.updates.length, 0),
      };
      if (!apply) return summary;
      for (const plan of plans) {
        const owner = vaultOwner(plan.row.vaultId);
        const backupPath = `migrations/btw-conversations/${plan.row.id}`;
        const existing = yield* Effect.result(storage.readText(owner, `${backupPath}/session.jsonl`));
        if (existing._tag === "Failure") {
          yield* storage.writeText(owner, `${backupPath}/rows.json`, JSON.stringify({
            session: plan.row,
            replies: replyRows.filter((reply) => reply.sessionId === plan.row.id && reply.vaultId === plan.row.vaultId),
            children: plan.conversions.slice(1).map((conversation) => conversation.id),
            sha256: createHash("sha256").update(plan.original).digest("hex"),
          }));
          if (plan.markdown !== null) yield* storage.writeText(owner, `${backupPath}/session.md`, plan.markdown);
          yield* storage.writeText(owner, `${backupPath}/session.jsonl`, plan.original);
        }
      }
      for (const plan of plans) {
        for (const conversation of plan.conversions) {
          const owner = vaultOwner(plan.row.vaultId);
          yield* storage.writeText(owner, sessionPath(conversation.id, "jsonl"), conversation.events.map((event) => `${JSON.stringify(encodeStoredEvent(event))}\n`).join(""));
          yield* storage.writeText(owner, sessionPath(conversation.id, "md"), renderSessionMarkdown(projectSession(conversation.events)));
        }
      }
      yield* db.transaction((tx) => Effect.gen(function* () {
        for (const plan of plans) {
          for (const conversation of plan.conversions) {
            const meta = conversation.events.find((event) => event.type === "meta")!;
            const updatedAt = conversation.events.at(-1)?.ts ?? meta.ts;
            yield* tx.insert(sessions).values({
              id: conversation.id,
              vaultId: plan.row.vaultId,
              userId: plan.row.userId,
              query: meta.query,
              kind: conversation.kind,
              origin: conversation.origin,
              createdAt: meta.ts,
              updatedAt,
              idempotencyKey: conversation.id === plan.row.id ? plan.row.idempotencyKey : `migrated-btw:${conversation.id}`,
            }).onConflictDoNothing();
            yield* tx.update(sessions).set({ origin: conversation.origin }).where(and(eq(sessions.id, conversation.id), eq(sessions.vaultId, plan.row.vaultId)));
          }
          for (const update of plan.updates) {
            yield* tx.update(replies).set({ sessionId: update.sessionId, kind: "exchange", request: update.request, sources: [...update.sources] }).where(eq(replies.id, update.id));
          }
        }
      }));
      return summary;
    }),
  );
    console.log(JSON.stringify(counts));
  } finally {
    await runtime.dispose();
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
