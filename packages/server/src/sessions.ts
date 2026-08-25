import { Database, sessions, userDocuments } from "@great-minds/database";
import {
  BadRequest,
  type BtwData,
  Forbidden,
  NotFound,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type ExchangeData,
  type OriginSessionDetail,
  type PromoteExchangeResponse,
  SessionBtwEvent as SessionBtwEventSchema,
  SessionExchangeEvent as SessionExchangeEventSchema,
  type BtwExchange,
  type ChunkRange,
  type PageParams,
  type SessionBtwEvent,
  type SessionEvent,
  type SessionExchangeEvent,
  type SessionId,
  type SessionMetaEvent,
  SessionMetaEvent as SessionMetaEventSchema,
  type SessionOrigin,
  SessionOrigin as SessionOriginSchema,
  type SessionOverview,
  type SessionPage,
  type SessionPathResponse,
  type SessionResponse,
  type ThinkingBlock,
  type ThinkingSource,
  type Uuid,
} from "@great-minds/domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { IngestService } from "./ingest.ts";
import { StructuredLogger } from "./logging.ts";
import { buildSessionExchangeDocument, sessionExchangePath } from "./markdown.ts";
import { pageEnvelope, oneTotal } from "./pagination.ts";
import { ProposalsService } from "./proposals.ts";
import { RandomBytesService, formatUuid7 } from "./random.ts";
import { SourceDocumentsService } from "./source-documents.ts";
import { ContentStorage, vaultOwner } from "./storage.ts";
import { VaultAccessService } from "./vaults.ts";
import { ClockService } from "./clock.ts";

type SessionsServiceShape = {
  readonly createSession: (
    userId: Uuid,
    vaultId: Uuid,
    input: CreateSessionRequest,
    replyId?: Uuid,
  ) => Effect.Effect<CreateSessionResponse, Forbidden>;
  readonly appendExchange: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
    input: ExchangeData,
    replyId?: Uuid,
  ) => Effect.Effect<SessionPathResponse, Forbidden | NotFound>;
  readonly appendBtw: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
    input: BtwData,
    replyId?: Uuid,
  ) => Effect.Effect<SessionPathResponse, Forbidden | NotFound>;
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

const decodeSessionOrigin = Schema.decodeUnknownSync(Schema.NullOr(SessionOriginSchema));
const decodeMetaEvent = Schema.decodeUnknownEffect(SessionMetaEventSchema);
const decodeExchangeEvent = Schema.decodeUnknownEffect(SessionExchangeEventSchema);
const decodeBtwEvent = Schema.decodeUnknownEffect(SessionBtwEventSchema);

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

const normalizeRange = (range: ChunkRange): ChunkRange => ({
  start: range.start,
  end: range.end,
});

const normalizeThinkingSource = (source: ThinkingSource): ThinkingSource => ({
  label: source.label,
  type: source.type,
  title: source.title,
  scope: source.scope,
  path: source.path,
  thinking: source.thinking,
  ranges: (source.ranges ?? []).map(normalizeRange),
  full: source.full ?? false,
});

const normalizeThinkingBlock = (block: ThinkingBlock): ThinkingBlock => ({
  sources: (block.sources ?? []).map(normalizeThinkingSource),
});

const normalizeBtwExchange = (exchange: BtwExchange): BtwExchange => ({
  query: exchange.query,
  thinking: (exchange.thinking ?? []).map(normalizeThinkingBlock),
  answer: exchange.answer ?? "",
});

const normalizeMetaEvent = (event: SessionMetaEvent): SessionMetaEvent => ({
  type: "meta",
  id: event.id,
  query: event.query,
  ts: event.ts,
  user_id: event.user_id,
  origin: normalizeOrigin(event.origin),
});

const normalizeExchangeEvent = (event: SessionExchangeEvent): SessionExchangeEvent => ({
  type: "exchange",
  exId: event.exId,
  ...(event.reply_id === undefined ? {} : { reply_id: event.reply_id }),
  query: event.query,
  thinking: (event.thinking ?? []).map(normalizeThinkingBlock),
  answer: event.answer ?? "",
  ts: event.ts,
});

const normalizeBtwEvent = (event: SessionBtwEvent): SessionBtwEvent => ({
  type: "btw",
  exId: event.exId,
  ...(event.reply_id === undefined ? {} : { reply_id: event.reply_id }),
  quote: event.quote,
  blockOffset: event.blockOffset ?? -1,
  context: event.context ?? "",
  exchanges: event.exchanges.map(normalizeBtwExchange),
  ts: event.ts,
});

const normalizeSessionEvent = (event: SessionEvent): SessionEvent => {
  switch (event.type) {
    case "meta":
      return normalizeMetaEvent(event);
    case "exchange":
      return normalizeExchangeEvent(event);
    case "btw":
      return normalizeBtwEvent(event);
  }
};

const latestMetaSuffix = (events: readonly SessionEvent[]) => {
  let latestMetaIndex = -1;
  for (const [index, event] of events.entries()) {
    if (event.type === "meta") {
      latestMetaIndex = index;
    }
  }
  return latestMetaIndex <= 0 ? events : events.slice(latestMetaIndex);
};

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

export const renderSessionMarkdown = (events: readonly SessionEvent[]) => {
  const exchanges: SessionExchangeEvent[] = [];
  const latestBtw = new Map<string, SessionBtwEvent>();

  for (const event of dedupeSessionExchanges(events)) {
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

export const dedupeSessionExchanges = (events: readonly SessionEvent[]): SessionEvent[] => {
  const latest = new Map<string, SessionExchangeEvent>();
  for (const event of events) {
    if (event.type === "exchange") {
      latest.set(event.exId, event);
    }
  }

  const emitted = new Set<string>();
  const deduped: SessionEvent[] = [];
  for (const event of events) {
    if (event.type !== "exchange") {
      deduped.push(event);
      continue;
    }
    if (emitted.has(event.exId)) {
      continue;
    }
    emitted.add(event.exId);
    const latestEvent = latest.get(event.exId);
    if (latestEvent !== undefined) {
      deduped.push(latestEvent);
    }
  }
  return deduped;
};

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

    // The origin document's current title, resolved at read time so the chip
    // shows the real title instead of the file stem. Personal references read
    // from user_documents.title; vault docs from the source-documents lookup.
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
            : eventType === "exchange"
              ? yield* Effect.result(decodeExchangeEvent(data))
              : eventType === "btw"
                ? yield* Effect.result(decodeBtwEvent(data))
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
        return normalizeSessionEvent(decoded.success);
      });

    const parseEvents = (
      sessionId: string,
      content: string,
      options: { readonly isolateLatestMeta: boolean },
    ) =>
      Effect.gen(function* () {
        const events: SessionEvent[] = [];
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

    const sessionFilePath = (sessionId: string) => `sessions/${sessionId}.jsonl`;

    const newSessionId = () =>
      Effect.gen(function* () {
        const now = yield* clock.now;
        const bytes = yield* randomBytes.bytes(16);
        return formatUuid7(now.getTime(), bytes);
      });

    const nowIso = () => Effect.map(clock.now, (now) => now.toISOString());

    const appendEvent = (vaultId: Uuid, sessionId: string, event: SessionEvent) =>
      storage.appendText(
        vaultOwner(vaultId),
        sessionFilePath(sessionId),
        `${JSON.stringify(event)}\n`,
      );

    const loadAllEvents = (vaultId: Uuid, sessionId: string) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          storage.readText(vaultOwner(vaultId), sessionFilePath(sessionId)),
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
          renderSessionMarkdown(events),
        );
      });

    const findExchange = (events: readonly SessionEvent[], exchangeId: string) =>
      dedupeSessionExchanges(events).find(
        (event): event is SessionExchangeEvent =>
          event.type === "exchange" && event.exId === exchangeId,
      );

    const findMeta = (events: readonly SessionEvent[]) =>
      events.find((event): event is SessionMetaEvent => event.type === "meta");

    // Sessions are personal: any path that touches a session's rows or events
    // must belong to the caller. Storage-only orphans (no DB row) keep the
    // legacy append/read behavior; real sessions always carry a row.
    const requireSessionOwner = (userId: Uuid, vaultId: Uuid, sessionId: SessionId) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) => d
          .select({ userId: sessions.userId })
          .from(sessions)
          .where(and(eq(sessions.vaultId, vaultId), eq(sessions.id, sessionId)))
          .limit(1));
        const row = rows[0];
        if (row !== undefined && row.userId !== userId) {
          return yield* new NotFound({ detail: "Session not found" });
        }
      });

    const exchangeEvent = (
      input: ExchangeData,
      ts: string,
      replyId?: Uuid,
    ): SessionExchangeEvent => ({
      type: "exchange",
      exId: input.id,
      ...(replyId === undefined ? {} : { reply_id: replyId }),
      query: input.query,
      thinking: (input.thinking ?? []).map(normalizeThinkingBlock),
      answer: input.answer,
      ts,
    });

    const btwEvent = (input: BtwData, ts: string, replyId?: Uuid): SessionBtwEvent => ({
      type: "btw",
      exId: input.exchangeId,
      ...(replyId === undefined ? {} : { reply_id: replyId }),
      quote: input.quote,
      blockOffset: input.blockOffset,
      context: input.context,
      exchanges: input.exchanges.map(normalizeBtwExchange),
      ts,
    });

    const appendExchangeEvent = (
      vaultId: Uuid,
      sessionId: string,
      input: ExchangeData,
      replyId?: Uuid,
    ) =>
      Effect.gen(function* () {
        const ts = yield* nowIso();
        const event = exchangeEvent(input, ts, replyId);
        yield* appendEvent(vaultId, sessionId, event);
        yield* db.query((d) => d
          .update(sessions)
          .set({ updatedAt: new Date(ts) })
          .where(and(eq(sessions.vaultId, vaultId), eq(sessions.id, sessionId))));
        yield* rebuildMarkdown(vaultId, sessionId);
        return { path: sessionFilePath(sessionId) } satisfies SessionPathResponse;
      });

    const appendBtwEvent = (
      vaultId: Uuid,
      sessionId: string,
      input: BtwData,
      replyId?: Uuid,
    ) =>
      Effect.gen(function* () {
        const ts = yield* nowIso();
        const event = btwEvent(input, ts, replyId);
        yield* appendEvent(vaultId, sessionId, event);
        yield* db.query((d) => d
          .update(sessions)
          .set({ updatedAt: new Date(ts) })
          .where(and(eq(sessions.vaultId, vaultId), eq(sessions.id, sessionId))));
        yield* rebuildMarkdown(vaultId, sessionId);
        return { path: sessionFilePath(sessionId) } satisfies SessionPathResponse;
      });

    return {
      createSession: (userId, vaultId, input, replyId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const existingRows = yield* db.query((d) => d
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              and(
                eq(sessions.vaultId, vaultId),
                eq(sessions.userId, userId),
                eq(sessions.idempotencyKey, input.idempotency_key),
              ),
            )
            .limit(1));
          const existing = existingRows[0]?.id;
          if (existing !== undefined) {
            const events = yield* loadAllEvents(vaultId, existing as SessionId).pipe(
              Effect.catchTag("NotFound", () =>
                logger
                  .error("session_create_replay_missing_jsonl", {
                    user_id: userId,
                    vault_id: vaultId,
                    session_id: existing,
                    idempotency_key: input.idempotency_key,
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
            if (findExchange(events, input.exchange.id) === undefined) {
              yield* appendExchangeEvent(vaultId, existing, input.exchange, replyId);
            }
            return { id: existing, path: sessionFilePath(existing) };
          }

          const sessionId = yield* newSessionId();
          const metaTs = yield* nowIso();
          const exchangeTs = yield* nowIso();
          const origin = normalizeOrigin(input.origin);
          const meta: SessionMetaEvent = {
            type: "meta",
            id: sessionId,
            query: input.exchange.query,
            ts: metaTs,
            user_id: userId,
            origin,
          };
          const exchange = exchangeEvent(input.exchange, exchangeTs, replyId);
          yield* appendEvent(vaultId, sessionId, meta);
          yield* appendEvent(vaultId, sessionId, exchange);
          yield* db.query((d) => d
            .insert(sessions)
            .values({
              id: sessionId,
              vaultId,
              userId,
              query: meta.query,
              origin,
              createdAt: new Date(metaTs),
              updatedAt: new Date(exchangeTs),
              idempotencyKey: input.idempotency_key,
            })
            .onConflictDoUpdate({
              target: [sessions.id, sessions.vaultId],
              set: {
                userId,
                query: meta.query,
                origin,
                createdAt: new Date(metaTs),
                updatedAt: new Date(exchangeTs),
              },
            }));
          yield* rebuildMarkdown(vaultId, sessionId);
          return { id: sessionId, path: sessionFilePath(sessionId) };
        }),
      appendExchange: (userId, vaultId, sessionId, input, replyId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          yield* requireSessionOwner(userId, vaultId, sessionId);
          return yield* appendExchangeEvent(vaultId, sessionId, input, replyId);
        }),
      appendBtw: (userId, vaultId, sessionId, input, replyId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          yield* requireSessionOwner(userId, vaultId, sessionId);
          return yield* appendBtwEvent(vaultId, sessionId, input, replyId);
        }),
      promoteExchange: (userId, vaultId, sessionId, exchangeId) =>
        Effect.gen(function* () {
          const scope = yield* access.requireEditor(userId, vaultId);
          const dest = sessionExchangePath(exchangeId);
          if (scope.role === "owner") {
            const existing = yield* sourceDocuments.getByPath(vaultId, dest);
            if (existing !== undefined) {
              return {
                mode: "ingested" as const,
                path: dest,
                title: existing.title,
                document_id: existing.id as Uuid,
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
          const exchange = findExchange(events, exchangeId);
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
              document_id: null,
              proposal_id: null,
            };
          }

          const proposal = yield* proposals.createRendered(vaultId, userId, {
            contentType: "session",
            title: null,
            author: null,
            destPath: dest,
            rendered: buildSessionExchangeDocument(sessionId, exchange, sessionOrigin),
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
          // Annotation threads (anchored origins) live with their document and
          // are served by listSessionsByOrigin; doc-initiated conversations
          // (origin with null anchor) stay in the main list.
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
              events: dedupeSessionExchanges(result.success),
            });
          }
          return details;
        }),
      readSession: (userId, vaultId, sessionId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          yield* requireSessionOwner(userId, vaultId, sessionId);
          const content = yield* readText(vaultId, sessionId, "jsonl", "Session not found");
          const events = dedupeSessionExchanges(
            yield* parseEvents(sessionId, content, { isolateLatestMeta: true }),
          );
          const origin = normalizeOrigin(findMeta(events)?.origin);
          return {
            id: sessionId,
            events,
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
