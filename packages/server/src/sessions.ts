import { Database, sessions } from "@great-minds/database";
import {
  Forbidden,
  NotFound,
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
  type SessionResponse,
  type ThinkingBlock,
  type ThinkingSource,
  type Uuid,
} from "@great-minds/domain";
import { and, desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { StructuredLogger } from "./logging.ts";
import { pageEnvelope, oneTotal } from "./pagination.ts";
import { VaultStorage } from "./storage.ts";
import { VaultAccessService } from "./vaults.ts";

export type SessionsServiceShape = {
  readonly listSessions: (
    userId: Uuid,
    vaultId: Uuid,
    params: PageParams,
  ) => Effect.Effect<SessionPage, Forbidden>;
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
        anchor: origin.anchor ?? null,
        paragraph: origin.paragraph ?? null,
        paragraph_index: origin.paragraph_index ?? null,
      };

const normalizeRange = (range: ChunkRange): ChunkRange => ({
  start: range.start,
  end: range.end,
});

const normalizeThinkingSource = (source: ThinkingSource): ThinkingSource => ({
  label: source.label,
  type: source.type,
  thinking: source.thinking ?? null,
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
  query: event.query,
  thinking: (event.thinking ?? []).map(normalizeThinkingBlock),
  answer: event.answer ?? "",
  ts: event.ts,
});

const normalizeBtwEvent = (event: SessionBtwEvent): SessionBtwEvent => ({
  type: "btw",
  exId: event.exId,
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

const sessionOverview = (row: typeof sessions.$inferSelect): SessionOverview => ({
  id: row.id,
  query: row.query,
  created_at: dateIso(row.createdAt),
  updated_at: dateIso(row.updatedAt),
  user_id: row.userId as Uuid,
  origin: normalizeOrigin(decodeSessionOrigin(row.origin)),
});

export const SessionsServiceLive = Layer.effect(
  SessionsService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;
    const storage = yield* VaultStorage;
    const logger = yield* StructuredLogger;

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

    const parseEvents = (sessionId: string, content: string) =>
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
          storage.readText(vaultId, sessionPath(sessionId, extension)),
        );
        if (result._tag === "Failure") {
          return yield* new NotFound({ detail: missingDetail });
        }
        return result.success;
      });

    return {
      listSessions: (userId, vaultId, params) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const where = and(eq(sessions.vaultId, vaultId), eq(sessions.userId, userId));
          const countRows = yield* db
            .select({ total: sql<number>`count(*)::int` })
            .from(sessions)
            .where(where)
            .pipe(Effect.orDie);
          const rows = yield* db
            .select()
            .from(sessions)
            .where(where)
            .orderBy(desc(sessions.updatedAt))
            .limit(params.limit)
            .offset(params.offset)
            .pipe(Effect.orDie);
          return pageEnvelope(rows.map(sessionOverview), params, oneTotal(countRows));
        }),
      readSession: (userId, vaultId, sessionId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const content = yield* readText(vaultId, sessionId, "jsonl", "Session not found");
          const events = yield* parseEvents(sessionId, content);
          return {
            id: sessionId,
            events,
          };
        }),
      readMarkdown: (userId, vaultId, sessionId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          return yield* readText(vaultId, sessionId, "md", "Session markdown not found");
        }),
    } satisfies SessionsServiceShape;
  }),
);
