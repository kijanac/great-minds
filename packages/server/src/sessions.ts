import { Database, sessions, userDocuments } from "@great-minds/database";
import {
  BadRequest,
  Forbidden,
  NotFound,
  type ExchangeId,
  ExchangeId as ExchangeIdSchema,
  IsoDateTime,
  type OriginSessionDetail,
  type PageParams,
  type PromoteExchangeResponse,
  type SessionBtwEvent,
  type SessionEvent,
  type SessionExchangeEvent,
  type SessionId,
  SessionId as SessionIdSchema,
  type SessionMetaEvent,
  SessionMetaEvent as SessionMetaEventSchema,
  type SessionOrigin,
  SessionOrigin as SessionOriginSchema,
  type SessionOverview,
  type SessionPage,
  type SessionResponse,
  type ThinkingSource,
  ThinkingSource as ThinkingSourceSchema,
  type Uuid,
  Uuid as UuidSchema,
} from "@great-minds/domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { IngestService } from "./ingest.ts";
import { LlmMessageSchema, type LlmMessage } from "./llm.ts";
import { StructuredLogger } from "./logging.ts";
import { buildSessionExchangeDocument, sessionExchangePath } from "./markdown.ts";
import { pageEnvelope, oneTotal } from "./pagination.ts";
import { ProposalsService } from "./proposals.ts";
import { RandomBytesService, formatUuid7 } from "./random.ts";
import { identifySourceMarkdown, sourceIdForKey } from "./source-identity.ts";
import { SourceDocumentsService } from "./source-documents.ts";
import { ContentStorage, vaultOwner } from "./storage.ts";
import { VaultAccessService } from "./vaults.ts";
import { ClockService } from "./clock.ts";

export const ReplyNodeStatus = Schema.Literals(["pending", "completed"] as const);

export const StoredBtwAnchor = Schema.Struct({
  exchange_id: ExchangeIdSchema,
  quote: Schema.String,
  block_offset: Schema.Number,
  context: Schema.String,
});
export type StoredBtwAnchor = typeof StoredBtwAnchor.Type;

export const ReplyNode = Schema.Struct({
  type: Schema.Literal("reply"),
  reply_id: UuidSchema,
  parent_reply_id: Schema.NullOr(UuidSchema),
  exchange_id: ExchangeIdSchema,
  btw: Schema.optionalKey(StoredBtwAnchor),
  question: Schema.String,
  status: ReplyNodeStatus,
  messages: Schema.Array(LlmMessageSchema),
  sources: Schema.Array(ThinkingSourceSchema),
  answer: Schema.String,
  ts: IsoDateTime,
});
export type ReplyNode = typeof ReplyNode.Type;

export const StoredSessionEvent = Schema.Union([SessionMetaEventSchema, ReplyNode]);
export type StoredSessionEvent = typeof StoredSessionEvent.Type;

const decodeSessionId = Schema.decodeUnknownSync(SessionIdSchema);
const decodeSessionOrigin = Schema.decodeUnknownSync(Schema.NullOr(SessionOriginSchema));
const decodeMetaEvent = Schema.decodeUnknownEffect(SessionMetaEventSchema);
const decodeReplyNode = Schema.decodeUnknownEffect(ReplyNode);

const dateIso = (value: Date) => value.toISOString();

const sessionPath = (sessionId: string, extension: "jsonl" | "md") =>
  `sessions/${sessionId}.${extension}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeOrigin = (origin: SessionOrigin | null | undefined): SessionOrigin | null =>
  origin === undefined || origin === null
    ? null
    : {
        doc_path: origin.doc_path,
        origin_scope: origin.origin_scope,
        anchor: origin.anchor,
        paragraph: origin.paragraph,
        paragraph_index: origin.paragraph_index,
      };

const latestMetaSuffix = (events: readonly StoredSessionEvent[]) => {
  let latestMetaIndex = -1;
  for (const [index, event] of events.entries()) {
    if (event.type === "meta") {
      latestMetaIndex = index;
    }
  }
  return latestMetaIndex <= 0 ? events : events.slice(latestMetaIndex);
};

export const currentNodes = (events: readonly StoredSessionEvent[]): readonly ReplyNode[] => {
  const latest = new Map<ExchangeId, ReplyNode>();
  for (const event of events) {
    if (event.type === "reply") {
      latest.set(event.exchange_id, event);
    }
  }
  return [...latest.values()];
};

const sameThread = (btw: StoredBtwAnchor | undefined) => (node: ReplyNode) =>
  btw === undefined
    ? node.btw === undefined
    : node.btw !== undefined &&
      node.btw.exchange_id === btw.exchange_id &&
      node.btw.quote === btw.quote;

const lastCompletedReplyId = (
  nodes: readonly ReplyNode[],
  inThread: (node: ReplyNode) => boolean,
): Uuid | null =>
  nodes.findLast((node) => node.status === "completed" && inThread(node))?.reply_id ?? null;

export const parentReplyIdFor = (
  nodes: readonly ReplyNode[],
  btw: StoredBtwAnchor | undefined,
): Uuid | null =>
  lastCompletedReplyId(nodes, sameThread(btw)) ?? lastCompletedReplyId(nodes, sameThread(undefined));

const stubToolResults = (messages: readonly LlmMessage[]): readonly LlmMessage[] =>
  messages.map((message) =>
    message.role === "tool"
      ? {
          ...message,
          content: "(tool result omitted from context; call the tool again if you need it)",
        }
      : message,
  );

const sessionOverview = (
  row: typeof sessions.$inferSelect,
  originTitle: string | null,
): SessionOverview => ({
  id: row.id,
  query: row.query,
  created_at: dateIso(row.createdAt),
  updated_at: dateIso(row.updatedAt),
  user_id: row.userId as Uuid,
  origin: normalizeOrigin(decodeSessionOrigin(row.origin)),
  origin_title: originTitle,
});

const thinkingBlocksFor = (sources: readonly ThinkingSource[]) =>
  sources.length === 0
    ? []
    : [{ sources: sources.map((source) => ({ ...source })) }];

const exchangeEventFromNode = (node: ReplyNode): SessionExchangeEvent => ({
  type: "exchange",
  exId: node.exchange_id,
  reply_id: node.reply_id,
  query: node.question,
  thinking: thinkingBlocksFor(node.sources),
  answer: node.answer,
  ts: node.ts,
});

const btwTurnFromNode = (node: ReplyNode) => ({
  exchange_id: node.exchange_id,
  query: node.question,
  thinking: thinkingBlocksFor(node.sources),
  answer: node.answer,
});

const btwEventFromNode = (node: ReplyNode, anchor: StoredBtwAnchor): SessionBtwEvent => ({
  type: "btw",
  exId: anchor.exchange_id,
  reply_id: node.reply_id,
  quote: anchor.quote,
  blockOffset: anchor.block_offset,
  context: anchor.context,
  exchanges: [btwTurnFromNode(node)],
  ts: node.ts,
});

export const projectSession = (events: readonly StoredSessionEvent[]): SessionEvent[] => {
  const metas = events.filter((event): event is SessionMetaEvent => event.type === "meta");
  const exchanges: SessionExchangeEvent[] = [];
  const threads = new Map<string, SessionBtwEvent>();
  for (const node of currentNodes(events)) {
    if (node.btw === undefined) {
      exchanges.push(exchangeEventFromNode(node));
      continue;
    }
    const key = `${node.btw.exchange_id}\0${node.btw.quote}`;
    const existing = threads.get(key);
    threads.set(
      key,
      existing === undefined
        ? btwEventFromNode(node, node.btw)
        : {
            ...existing,
            reply_id: node.reply_id,
            exchanges: [...existing.exchanges, btwTurnFromNode(node)],
            ts: node.ts,
          },
    );
  }
  return [...metas, ...exchanges, ...threads.values()];
};

export const renderSessionMarkdown = (events: readonly SessionEvent[]) => {
  const exchanges: SessionExchangeEvent[] = [];
  const latestBtw = new Map<string, SessionBtwEvent>();

  for (const event of events) {
    if (event.type === "exchange") {
      exchanges.push(event);
    } else if (event.type === "btw") {
      const key = `${event.exId}\0${event.quote}`;
      const existing = latestBtw.get(key);
      if (existing === undefined || event.ts >= existing.ts) {
        latestBtw.set(key, event);
      }
    }
  }

  const btwsByExchange = new Map<string, SessionBtwEvent[]>();
  for (const btw of latestBtw.values()) {
    const existing = btwsByExchange.get(btw.exId) ?? [];
    existing.push(btw);
    btwsByExchange.set(btw.exId, existing);
  }

  const parts: string[] = [];
  for (const [index, exchange] of exchanges.entries()) {
    if (index > 0) {
      parts.push("\n---\n\n");
    }
    parts.push(`# ${exchange.query}\n\n`);

    for (const block of exchange.thinking ?? []) {
      for (const source of block.sources ?? []) {
        parts.push(`> \`${source.label}\`\n`);
      }
      parts.push(">\n");
    }

    parts.push(`${exchange.answer ?? ""}\n`);

    for (const btw of btwsByExchange.get(exchange.exId) ?? []) {
      const short = btw.quote.length > 60 ? `${btw.quote.slice(0, 60)}...` : btw.quote;
      parts.push(`\n> **BTW** re: "${short}"\n>\n`);
      for (const inner of btw.exchanges) {
        parts.push(`> *${inner.query}*\n>\n`);
        parts.push(`> ${inner.answer ?? ""}\n>\n`);
      }
    }
  }

  return `${parts.join("").replace(/\s+$/u, "")}\n`;
};

type SessionCreate = {
  readonly idempotencyKey: string;
  readonly origin?: SessionOrigin;
  readonly pending: PendingReply;
};

type PendingReply = {
  readonly replyId: Uuid;
  readonly exchangeId: ExchangeId;
  readonly btw?: StoredBtwAnchor;
  readonly question: string;
};

type CompletedReply = {
  readonly messages: readonly LlmMessage[];
  readonly sources: readonly ThinkingSource[];
  readonly answer: string;
};

export type ReplyTranscript = {
  readonly prior: readonly LlmMessage[];
  readonly threadRoot: boolean;
};

type SessionsServiceShape = {
  readonly createSession: (
    userId: Uuid,
    vaultId: Uuid,
    input: SessionCreate,
  ) => Effect.Effect<SessionId, Forbidden>;
  readonly appendPending: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
    pending: PendingReply,
  ) => Effect.Effect<void, Forbidden | NotFound>;
  readonly completeReply: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
    replyId: Uuid,
    completed: CompletedReply,
  ) => Effect.Effect<void, Forbidden | NotFound>;
  readonly readTranscript: (
    vaultId: Uuid,
    sessionId: SessionId,
    replyId: Uuid,
  ) => Effect.Effect<ReplyTranscript, NotFound>;
  readonly promoteExchange: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
    exchangeId: string,
  ) => Effect.Effect<PromoteExchangeResponse, BadRequest | Forbidden | NotFound>;
  readonly listSessions: (
    userId: Uuid,
    vaultId: Uuid,
    params: PageParams,
  ) => Effect.Effect<SessionPage, Forbidden>;
  readonly listSessionsByOrigin: (
    userId: Uuid,
    vaultId: Uuid,
    docPath: string,
  ) => Effect.Effect<readonly OriginSessionDetail[], Forbidden>;
  readonly readSession: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
  ) => Effect.Effect<SessionResponse, Forbidden | NotFound>;
  readonly readMarkdown: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
  ) => Effect.Effect<string, Forbidden | NotFound>;
};

export class SessionsService extends Context.Service<SessionsService, SessionsServiceShape>()(
  "@great-minds/server/SessionsService",
) {}

export const SessionsServiceLive = Layer.effect(
  SessionsService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;
    const storage = yield* ContentStorage;
    const logger = yield* StructuredLogger;
    const clock = yield* ClockService;
    const randomBytes = yield* RandomBytesService;
    const sourceDocuments = yield* SourceDocumentsService;
    const proposals = yield* ProposalsService;
    const ingest = yield* IngestService;

    const originTitleFor = (userId: Uuid, vaultId: Uuid, origin: SessionOrigin | null) =>
      Effect.gen(function* () {
        if (origin === null) {
          return null;
        }
        if (origin.origin_scope === "personal") {
          const rows = yield* db.query((d) => d
            .select({ title: userDocuments.title })
            .from(userDocuments)
            .where(
              and(
                eq(userDocuments.userId, userId),
                eq(userDocuments.filePath, origin.doc_path),
              ),
            )
            .limit(1));
          return rows[0]?.title ?? null;
        }
        const row = yield* sourceDocuments.getByPath(vaultId, origin.doc_path);
        return row?.title ?? null;
      });

    const decodeEventLine = (sessionId: string, lineNumber: number, data: unknown) =>
      Effect.gen(function* () {
        const eventType = isRecord(data) && typeof data.type === "string" ? data.type : null;
        const decoded =
          eventType === "meta"
            ? yield* Effect.result(decodeMetaEvent(data))
            : eventType === "reply"
              ? yield* Effect.result(decodeReplyNode(data))
              : undefined;

        if (decoded === undefined) {
          yield* logger.warn("session_event_skipped", {
            session_id: sessionId,
            line: lineNumber,
            reason: "unknown_type",
            event_type: eventType,
          });
          return undefined;
        }
        if (decoded._tag === "Failure") {
          yield* logger.warn("session_event_skipped", {
            session_id: sessionId,
            line: lineNumber,
            reason: "invalid_event",
            event_type: eventType,
            error_message: String(decoded.failure),
          });
          return undefined;
        }
        return decoded.success;
      });

    const parseEvents = (
      sessionId: string,
      content: string,
      options: { readonly isolateLatestMeta: boolean },
    ) =>
      Effect.gen(function* () {
        const events: StoredSessionEvent[] = [];
        const lines = content.trim().split("\n");
        for (const [index, rawLine] of lines.entries()) {
          const line = rawLine.trim();
          if (line === "") {
            continue;
          }
          let data: unknown;
          try {
            data = JSON.parse(line) as unknown;
          } catch (error) {
            yield* logger.warn("session_jsonl_truncated", {
              session_id: sessionId,
              line: index + 1,
              error_message: error instanceof Error ? error.message : String(error),
            });
            break;
          }
          const event = yield* decodeEventLine(sessionId, index + 1, data);
          if (event !== undefined) {
            events.push(event);
          }
        }
        if (!options.isolateLatestMeta) {
          return events;
        }
        const isolated = latestMetaSuffix(events);
        if (isolated.length !== events.length) {
          yield* logger.warn("session_stale_prefix_dropped", {
            session_id: sessionId,
            dropped_events: events.length - isolated.length,
          });
        }
        return isolated;
      });

    const readText = (
      vaultId: Uuid,
      sessionId: SessionId,
      extension: "jsonl" | "md",
      missingDetail: string,
    ) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          storage.readText(vaultOwner(vaultId), sessionPath(sessionId, extension)),
        );
        if (result._tag === "Failure") {
          return yield* new NotFound({ detail: missingDetail });
        }
        return result.success;
      });

    const newSessionId = () =>
      Effect.gen(function* () {
        const now = yield* clock.now;
        const bytes = yield* randomBytes.bytes(16);
        return decodeSessionId(formatUuid7(now.getTime(), bytes));
      });

    const nowIso = () => Effect.map(clock.now, (now) => now.toISOString());

    const appendEvent = (vaultId: Uuid, sessionId: string, event: StoredSessionEvent) =>
      storage.appendText(
        vaultOwner(vaultId),
        sessionPath(sessionId, "jsonl"),
        `${JSON.stringify(event)}\n`,
      );

    const loadAllEvents = (vaultId: Uuid, sessionId: string) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          storage.readText(vaultOwner(vaultId), sessionPath(sessionId, "jsonl")),
        );
        if (result._tag === "Failure") {
          return yield* new NotFound({ detail: "Session not found" });
        }
        return yield* parseEvents(sessionId, result.success, { isolateLatestMeta: false });
      });

    const rebuildMarkdown = (vaultId: Uuid, sessionId: string) =>
      Effect.gen(function* () {
        const events = yield* loadAllEvents(vaultId, sessionId).pipe(
          Effect.catchTag("NotFound", (error) => Effect.die(error)),
        );
        yield* storage.writeText(
          vaultOwner(vaultId),
          sessionPath(sessionId, "md"),
          renderSessionMarkdown(projectSession(events)),
        );
      });

    const findMeta = (events: readonly StoredSessionEvent[]) =>
      events.find((event): event is SessionMetaEvent => event.type === "meta");

    const requireSessionOwner = (userId: Uuid, vaultId: Uuid, sessionId: SessionId) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) => d
          .select({ userId: sessions.userId })
          .from(sessions)
          .where(and(eq(sessions.vaultId, vaultId), eq(sessions.id, sessionId)))
          .limit(1));
        const row = rows[0];
        if (row === undefined || row.userId !== userId) {
          return yield* new NotFound({ detail: "Session not found" });
        }
      });

    const pendingNode = (
      ts: string,
      pending: PendingReply,
      parentReplyId: Uuid | null,
    ): ReplyNode => ({
      type: "reply",
      reply_id: pending.replyId,
      parent_reply_id: parentReplyId,
      exchange_id: pending.exchangeId,
      ...(pending.btw === undefined ? {} : { btw: pending.btw }),
      question: pending.question,
      status: "pending",
      messages: [],
      sources: [],
      answer: "",
      ts,
    });

    const completedNodeFrom = (ts: string, pending: ReplyNode, completed: CompletedReply): ReplyNode => ({
      type: "reply",
      reply_id: pending.reply_id,
      parent_reply_id: pending.parent_reply_id,
      exchange_id: pending.exchange_id,
      ...(pending.btw === undefined ? {} : { btw: pending.btw }),
      question: pending.question,
      status: "completed",
      messages: [...completed.messages],
      sources: [...completed.sources],
      answer: completed.answer,
      ts,
    });

    const appendNode = (vaultId: Uuid, sessionId: string, node: ReplyNode) =>
      Effect.gen(function* () {
        yield* appendEvent(vaultId, sessionId, node);
        yield* db.query((d) => d
          .update(sessions)
          .set({ updatedAt: new Date(node.ts) })
          .where(and(eq(sessions.vaultId, vaultId), eq(sessions.id, sessionId))));
        yield* rebuildMarkdown(vaultId, sessionId);
      });

    const hasNodeForExchange = (events: readonly StoredSessionEvent[], exchangeId: ExchangeId) =>
      events.some(
        (event) => event.type === "reply" && event.exchange_id === exchangeId,
      );

    const nodesByReplyId = (events: readonly StoredSessionEvent[]) => {
      const byReplyId = new Map<Uuid, ReplyNode>();
      for (const event of events) {
        if (event.type === "reply") {
          byReplyId.set(event.reply_id, event);
        }
      }
      return byReplyId;
    };

    return {
      createSession: (userId, vaultId, input) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const existingRows = yield* db.query((d) => d
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              and(
                eq(sessions.vaultId, vaultId),
                eq(sessions.userId, userId),
                eq(sessions.idempotencyKey, input.idempotencyKey),
              ),
            )
            .limit(1));
          const existing = existingRows[0]?.id;
          if (existing !== undefined) {
            const events = yield* loadAllEvents(vaultId, decodeSessionId(existing)).pipe(
              Effect.catchTag("NotFound", () =>
                logger
                  .error("session_create_replay_missing_jsonl", {
                    user_id: userId,
                    vault_id: vaultId,
                    session_id: existing,
                    idempotency_key: input.idempotencyKey,
                  })
                  .pipe(
                    Effect.andThen(
                      Effect.die(
                        new Error(`Session ${existing} has a database row but no JSONL file`),
                      ),
                    ),
                  ),
              ),
            );
            if (!hasNodeForExchange(events, input.pending.exchangeId)) {
              const ts = yield* nowIso();
              yield* appendNode(
                vaultId,
                existing,
                pendingNode(ts, input.pending, parentReplyIdFor(currentNodes(events), input.pending.btw)),
              );
            }
            return decodeSessionId(existing);
          }

          const sessionId = yield* newSessionId();
          const metaTs = yield* nowIso();
          const nodeTs = yield* nowIso();
          const origin = normalizeOrigin(input.origin);
          const meta: SessionMetaEvent = {
            type: "meta",
            id: sessionId,
            query: input.pending.question,
            ts: metaTs,
            user_id: userId,
            origin,
          };
          const node = pendingNode(nodeTs, input.pending, null);
          yield* appendEvent(vaultId, sessionId, meta);
          yield* appendEvent(vaultId, sessionId, node);
          yield* db.query((d) => d
            .insert(sessions)
            .values({
              id: sessionId,
              vaultId,
              userId,
              query: meta.query,
              origin,
              createdAt: new Date(metaTs),
              updatedAt: new Date(nodeTs),
              idempotencyKey: input.idempotencyKey,
            })
            .onConflictDoUpdate({
              target: [sessions.id, sessions.vaultId],
              set: {
                userId,
                query: meta.query,
                origin,
                createdAt: new Date(metaTs),
                updatedAt: new Date(nodeTs),
              },
            }));
          yield* rebuildMarkdown(vaultId, sessionId);
          return sessionId;
        }),
      appendPending: (userId, vaultId, sessionId, pending) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          yield* requireSessionOwner(userId, vaultId, sessionId);
          const events = yield* loadAllEvents(vaultId, sessionId);
          const ts = yield* nowIso();
          yield* appendNode(
            vaultId,
            sessionId,
            pendingNode(ts, pending, parentReplyIdFor(currentNodes(events), pending.btw)),
          );
        }),
      completeReply: (userId, vaultId, sessionId, replyId, completed) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          yield* requireSessionOwner(userId, vaultId, sessionId);
          const events = yield* loadAllEvents(vaultId, sessionId);
          const pending = nodesByReplyId(events).get(replyId);
          if (pending === undefined) {
            return yield* Effect.die(
              new Error(`Reply ${replyId} has no pending node in session ${sessionId}`),
            );
          }
          if (pending.status === "completed") {
            return;
          }
          const ts = yield* nowIso();
          yield* appendNode(vaultId, sessionId, completedNodeFrom(ts, pending, completed));
        }),
      readTranscript: (vaultId, sessionId, replyId) =>
        Effect.gen(function* () {
          const byReplyId = nodesByReplyId(yield* loadAllEvents(vaultId, sessionId));
          const pending = byReplyId.get(replyId);
          if (pending === undefined) {
            return yield* Effect.die(
              new Error(`Reply ${replyId} has no pending node in session ${sessionId}`),
            );
          }
          const chain: ReplyNode[] = [];
          let current = pending;
          while (current.parent_reply_id !== null) {
            const parent = byReplyId.get(current.parent_reply_id);
            if (parent === undefined) {
              return yield* Effect.die(
                new Error(`Reply ${current.reply_id} parent ${current.parent_reply_id} is missing`),
              );
            }
            chain.unshift(parent);
            current = parent;
          }
          const parent = chain.at(-1);
          return {
            prior: chain.flatMap((node) =>
              node === parent ? node.messages : stubToolResults(node.messages),
            ),
            threadRoot: parent === undefined || !sameThread(pending.btw)(parent),
          };
        }),
      promoteExchange: (userId, vaultId, sessionId, exchangeId) =>
        Effect.gen(function* () {
          const scope = yield* access.requireEditor(userId, vaultId);
          yield* requireSessionOwner(userId, vaultId, sessionId);
          const sourceId = sourceIdForKey(
            vaultId,
            `session:${sessionId}:${exchangeId}`,
          );
          const dest = sessionExchangePath(exchangeId, sourceId);
          if (scope.role === "owner") {
            const existing = yield* sourceDocuments.getById(vaultId, sourceId);
            if (existing !== undefined) {
              return {
                mode: "ingested" as const,
                path: existing.filePath,
                title: existing.title,
                document_id: sourceId,
                proposal_id: null,
              };
            }
          } else {
            const existing = yield* proposals.findPendingForDest(vaultId, dest);
            if (existing !== undefined) {
              return {
                mode: "proposed" as const,
                path: dest,
                title: existing.title,
                document_id: null,
                proposal_id: existing.id,
              };
            }
          }

          const events = yield* loadAllEvents(vaultId, sessionId);
          if (events.length === 0) {
            return yield* new NotFound({ detail: "Session not found" });
          }
          const projected = projectSession(events);
          const exchange = projected.find(
            (event): event is SessionExchangeEvent =>
              event.type === "exchange" && event.exId === exchangeId,
          );
          if (exchange === undefined) {
            return yield* new NotFound({ detail: "Exchange not found in session" });
          }
          if ((exchange.answer ?? "").trim().length === 0) {
            return yield* new BadRequest({ detail: "Exchange has no answer yet" });
          }
          const sessionOrigin = normalizeOrigin(findMeta(events)?.origin);

          if (scope.role === "owner") {
            const result = yield* ingest.ingestSessionExchange(
              vaultId,
              sessionId,
              exchange,
              sessionOrigin,
            );
            return {
              mode: "ingested" as const,
              path: result.file_path,
              title: null,
              document_id: result.id,
              proposal_id: null,
            };
          }

          const proposal = yield* proposals.createRendered(vaultId, userId, {
            sourceId,
            contentType: "session",
            title: null,
            author: null,
            destPath: dest,
            rendered: identifySourceMarkdown(
              buildSessionExchangeDocument(sessionId, exchange, sessionOrigin),
              sourceId,
            ),
          });
          return {
            mode: "proposed" as const,
            path: dest,
            title: null,
            document_id: null,
            proposal_id: proposal.id,
          };
        }),
      listSessions: (userId, vaultId, params) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const where = and(
            eq(sessions.vaultId, vaultId),
            eq(sessions.userId, userId),
            sql`${sessions.origin}->>'anchor' IS NULL`,
          );
          const countRows = yield* db.query((d) => d
            .select({ total: sql<number>`count(*)::int` })
            .from(sessions)
            .where(where));
          const rows = yield* db.query((d) => d
            .select()
            .from(sessions)
            .where(where)
            .orderBy(desc(sessions.updatedAt))
            .limit(params.limit)
            .offset(params.offset));
          const overviews: SessionOverview[] = [];
          for (const row of rows) {
            const originTitle = yield* originTitleFor(
              userId,
              vaultId,
              normalizeOrigin(decodeSessionOrigin(row.origin)),
            );
            overviews.push(sessionOverview(row, originTitle));
          }
          return pageEnvelope(overviews, params, oneTotal(countRows));
        }),
      listSessionsByOrigin: (userId, vaultId, docPath) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const rows = yield* db.query((d) => d
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.vaultId, vaultId),
                eq(sessions.userId, userId),
                sql`${sessions.origin}->>'doc_path' = ${docPath}`,
              ),
            )
            .orderBy(asc(sessions.createdAt)));
          const details: OriginSessionDetail[] = [];
          for (const row of rows) {
            const result = yield* Effect.result(
              readText(vaultId, row.id as SessionId, "jsonl", "Session not found").pipe(
                Effect.flatMap((content) =>
                  parseEvents(row.id, content, { isolateLatestMeta: true }),
                ),
              ),
            );
            if (result._tag === "Failure") {
              yield* logger.warn("session_by_origin_skipped", {
                session_id: row.id,
                doc_path: docPath,
                reason: "missing_jsonl",
              });
              continue;
            }
            const originTitle = yield* originTitleFor(
              userId,
              vaultId,
              normalizeOrigin(decodeSessionOrigin(row.origin)),
            );
            details.push({
              session: sessionOverview(row, originTitle),
              events: projectSession(result.success),
            });
          }
          return details;
        }),
      readSession: (userId, vaultId, sessionId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          yield* requireSessionOwner(userId, vaultId, sessionId);
          const content = yield* readText(vaultId, sessionId, "jsonl", "Session not found");
          const events = yield* parseEvents(sessionId, content, { isolateLatestMeta: true });
          const projected = projectSession(events);
          const origin = normalizeOrigin(
            projected.find(
              (event): event is SessionMetaEvent => event.type === "meta",
            )?.origin,
          );
          return {
            id: sessionId,
            events: projected,
            origin_title: yield* originTitleFor(userId, vaultId, origin),
          };
        }),
      readMarkdown: (userId, vaultId, sessionId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          yield* requireSessionOwner(userId, vaultId, sessionId);
          return yield* readText(vaultId, sessionId, "md", "Session markdown not found");
        }),
    } satisfies SessionsServiceShape;
  }),
);
