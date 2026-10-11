import { Database, sessions, userDocuments } from "@great-minds/database";
import {
  BadRequest,
  composeAnchoredQuestion,
  Forbidden,
  NotFound,
  ServiceUnavailable,
  type OriginSessionDetail,
  type PageParams,
  type PromoteExchangeResponse,
  type SessionExchangeEvent,
  type SessionId,
  type SessionOrigin,
  SessionOrigin as SessionOriginSchema,
  type SessionOverview,
  type SessionPage,
  type SessionResponse,
  type Uuid,
} from "@great-minds/domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { ClockService } from "./clock.ts";
import { type ConversationHistory, HistoryInvalid } from "./conversation-history/history.ts";
import {
  projectSession,
  publicationExchanges,
  renderSessionMarkdown,
} from "./conversation-history/presentation.ts";
import { HistoryStore } from "./conversation-history/store.ts";
import { IngestService } from "./ingest.ts";
import type { LlmMessage } from "./llm.ts";
import { StructuredLogger } from "./logging.ts";
import { buildSessionExchangeDocument, sessionExchangePath } from "./markdown.ts";
import { pageEnvelope, oneTotal } from "./pagination.ts";
import { ProposalsService } from "./proposals.ts";
import { identifySourceMarkdown, sourceIdForKey } from "./source-identity.ts";
import { SourceDocumentsService } from "./source-documents.ts";
import { VaultAccessService } from "./vaults.ts";

type SessionRow = typeof sessions.$inferSelect;
type SessionReadError = Forbidden | NotFound | ServiceUnavailable;

export type ReplyTranscript = {
  readonly prior: readonly LlmMessage[];
  readonly question: string;
};

type SessionsServiceShape = {
  readonly continueAsSession: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
  ) => Effect.Effect<void, Forbidden | NotFound>;
  readonly readTranscript: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
    replyId: Uuid,
  ) => Effect.Effect<ReplyTranscript, SessionReadError>;
  readonly readReplyQuestion: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
    replyId: Uuid,
  ) => Effect.Effect<string, SessionReadError>;
  readonly promoteExchange: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
    exchangeId: string,
  ) => Effect.Effect<PromoteExchangeResponse, BadRequest | SessionReadError>;
  readonly listSessions: (
    userId: Uuid,
    vaultId: Uuid,
    params: PageParams,
  ) => Effect.Effect<SessionPage, Forbidden>;
  readonly listSessionsByOrigin: (
    userId: Uuid,
    vaultId: Uuid,
    docPath: string,
  ) => Effect.Effect<readonly OriginSessionDetail[], SessionReadError>;
  readonly readSession: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
  ) => Effect.Effect<SessionResponse, SessionReadError>;
  readonly readMarkdown: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
  ) => Effect.Effect<string, SessionReadError>;
  readonly readPublication: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
  ) => Effect.Effect<readonly SessionExchangeEvent[], SessionReadError>;
};

export class SessionsService extends Context.Service<SessionsService, SessionsServiceShape>()(
  "@great-minds/server/SessionsService",
) {}

const decodeSessionOrigin = Schema.decodeUnknownSync(Schema.NullOr(SessionOriginSchema));
const kindFor = (row: SessionRow) =>
  row.placement === "inline" ? ("btw" as const) : ("session" as const);
const sessionOverview = (row: SessionRow, originTitle: string | null): SessionOverview => ({
  id: row.id,
  kind: kindFor(row),
  query: row.query,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
  user_id: row.userId,
  origin: decodeSessionOrigin(row.origin),
  origin_title: originTitle,
});

const stubToolResults = (messages: readonly LlmMessage[]): readonly LlmMessage[] =>
  messages.map((message) =>
    message.role === "tool"
      ? {
          ...message,
          content: "(tool result omitted from context; call the tool again if you need it)",
        }
      : message,
  );

const attemptFor = (history: ConversationHistory, replyId: Uuid) =>
  history.turns
    .flatMap((turn) => turn.attempts)
    .find((attempt) => attempt.accepted.reply_id === replyId);

const questionFor = (history: ConversationHistory, replyId: Uuid) =>
  Effect.gen(function* () {
    const attempt = attemptFor(history, replyId);
    if (attempt === undefined)
      return yield* new NotFound({ detail: "Reply not found in conversation history" });
    const origin = history.header.origin;
    return attempt.accepted.parent_reply_id === null &&
      origin?.anchor !== null &&
      origin?.anchor !== undefined
      ? composeAnchoredQuestion(
          { quote: origin.anchor, context: origin.paragraph },
          attempt.accepted.question,
        )
      : attempt.accepted.question;
  });

export const SessionsServiceLive = Layer.effect(
  SessionsService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;
    const histories = yield* HistoryStore;
    const logger = yield* StructuredLogger;
    const clock = yield* ClockService;
    const sourceDocuments = yield* SourceDocumentsService;
    const proposals = yield* ProposalsService;
    const ingest = yield* IngestService;

    const requireSessionOwner = (userId: Uuid, vaultId: Uuid, sessionId: SessionId) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) =>
          d
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.vaultId, vaultId),
                eq(sessions.id, sessionId),
                eq(sessions.userId, userId),
              ),
            )
            .limit(1),
        );
        const row = rows[0];
        if (row === undefined) return yield* new NotFound({ detail: "Session not found" });
        return row;
      });

    const loadHistory = (row: SessionRow) =>
      Effect.gen(function* () {
        if (row.historySeq === null || row.historySha256 === null) {
          return yield* new HistoryInvalid({
            session_id: row.id,
            line: 1,
            reason: "history_receipt",
          });
        }
        const file = yield* histories.read(
          { vault_id: row.vaultId, session_id: row.id },
          {
            last_seq: row.historySeq,
            sha256: row.historySha256,
          },
        );
        if (file === null)
          return yield* new HistoryInvalid({
            session_id: row.id,
            line: 1,
            reason: "history_receipt",
          });
        return file.history;
      }).pipe(
        Effect.tapError((error) =>
          logger.warn("conversation_history_unavailable", {
            session_id: row.id,
            vault_id: row.vaultId,
            error_tag: error._tag,
          }),
        ),
        Effect.mapError(
          () =>
            new ServiceUnavailable({
              detail: "Conversation history is unavailable; no content has been discarded",
            }),
        ),
      );

    const ownedHistory = (userId: Uuid, vaultId: Uuid, sessionId: SessionId) =>
      Effect.gen(function* () {
        const row = yield* requireSessionOwner(userId, vaultId, sessionId);
        return yield* loadHistory(row);
      });

    const originTitleFor = (userId: Uuid, vaultId: Uuid, origin: SessionOrigin | null) =>
      Effect.gen(function* () {
        if (origin === null) return null;
        if (origin.kind === "answer") {
          const rows = yield* db.query((d) =>
            d
              .select({ query: sessions.query })
              .from(sessions)
              .where(
                and(
                  eq(sessions.vaultId, vaultId),
                  eq(sessions.userId, userId),
                  eq(sessions.id, origin.session_id),
                ),
              )
              .limit(1),
          );
          return rows[0]?.query ?? null;
        }
        if (origin.origin_scope === "personal") {
          const rows = yield* db.query((d) =>
            d
              .select({ title: userDocuments.title })
              .from(userDocuments)
              .where(
                and(eq(userDocuments.userId, userId), eq(userDocuments.filePath, origin.doc_path)),
              )
              .limit(1),
          );
          return rows[0]?.title ?? null;
        }
        return (yield* sourceDocuments.getByPath(vaultId, origin.doc_path))?.title ?? null;
      });

    const sessionDetail = (row: SessionRow) =>
      Effect.gen(function* () {
        const history = yield* loadHistory(row);
        const title = yield* originTitleFor(row.userId, row.vaultId, history.header.origin);
        return {
          session: sessionOverview(row, title),
          events: projectSession(history),
        } satisfies OriginSessionDetail;
      });

    const readPublication = (userId: Uuid, vaultId: Uuid, sessionId: SessionId) =>
      Effect.gen(function* () {
        yield* access.requireMember(userId, vaultId);
        return publicationExchanges(
          projectSession(yield* ownedHistory(userId, vaultId, sessionId)),
        );
      });

    return {
      continueAsSession: (userId, vaultId, sessionId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          yield* db.transaction(
            Effect.fn(function* (tx) {
              const rows = yield* tx
                .select()
                .from(sessions)
                .where(and(eq(sessions.id, sessionId), eq(sessions.vaultId, vaultId)))
                .for("update");
              const row = rows[0];
              if (row === undefined || row.userId !== userId)
                return yield* new NotFound({ detail: "Session not found" });
              if (row.placement === "standalone" && row.replyMode === "query") return;
              const now = yield* clock.now;
              yield* tx
                .update(sessions)
                .set({
                  placement: "standalone",
                  replyMode: "query",
                  revision: sql`${sessions.revision} + 1`,
                  updatedAt: sql`greatest(${sessions.updatedAt}, ${now})`,
                })
                .where(eq(sessions.id, sessionId));
            }),
          );
        }),
      readReplyQuestion: (userId, vaultId, sessionId, replyId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          return yield* questionFor(yield* ownedHistory(userId, vaultId, sessionId), replyId);
        }),
      readTranscript: (userId, vaultId, sessionId, replyId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          let history = yield* ownedHistory(userId, vaultId, sessionId);
          const question = yield* questionFor(history, replyId);
          const attempt = attemptFor(history, replyId);
          if (attempt === undefined)
            return yield* new NotFound({ detail: "Reply not found in conversation history" });
          let parent =
            attempt.accepted.parent_reply_id === null
              ? history.header.context
              : { session_id: sessionId, reply_id: attempt.accepted.parent_reply_id };
          const visited = new Set([`${sessionId}:${replyId}`]);
          const chain: (readonly LlmMessage[])[] = [];
          while (parent !== null) {
            const key = `${parent.session_id}:${parent.reply_id}`;
            if (visited.has(key))
              return yield* new ServiceUnavailable({
                detail: "Conversation context contains a cycle",
              });
            visited.add(key);
            if (history.header.session_id !== parent.session_id) {
              history = yield* ownedHistory(userId, vaultId, parent.session_id);
            }
            const previous = attemptFor(history, parent.reply_id);
            if (
              previous === undefined ||
              previous.settlement === null ||
              previous.settlement.outcome.status === "failed" ||
              previous.settlement.context_messages === null
            ) {
              return yield* new ServiceUnavailable({
                detail: "Recorded conversation context is unavailable",
              });
            }
            chain.push(previous.settlement.context_messages);
            parent =
              previous.accepted.parent_reply_id === null
                ? history.header.context
                : {
                    session_id: history.header.session_id,
                    reply_id: previous.accepted.parent_reply_id,
                  };
          }
          return {
            question,
            prior: chain
              .reverse()
              .flatMap((messages, index) =>
                index === chain.length - 1 ? messages : stubToolResults(messages),
              ),
          };
        }),
      promoteExchange: (userId, vaultId, sessionId, exchangeId) =>
        Effect.gen(function* () {
          const scope = yield* access.requireEditor(userId, vaultId);
          const row = yield* requireSessionOwner(userId, vaultId, sessionId);
          const sourceId = sourceIdForKey(vaultId, `session:${sessionId}:${exchangeId}`);
          const dest = sessionExchangePath(exchangeId, sourceId);
          if (scope.role === "owner") {
            const existing = yield* sourceDocuments.getById(vaultId, sourceId);
            if (existing !== undefined)
              return {
                mode: "ingested" as const,
                path: existing.filePath,
                title: existing.title,
                document_id: sourceId,
                proposal_id: null,
              };
          } else {
            const existing = yield* proposals.findPendingForDest(vaultId, dest);
            if (existing !== undefined)
              return {
                mode: "proposed" as const,
                path: dest,
                title: existing.title,
                document_id: null,
                proposal_id: existing.id,
              };
          }
          const history = yield* loadHistory(row);
          const exchange = projectSession(history).find(
            (event): event is SessionExchangeEvent =>
              event.type === "exchange" && event.exId === exchangeId,
          );
          if (exchange === undefined)
            return yield* new NotFound({ detail: "Exchange not found in session" });
          if (exchange.status !== "completed" && exchange.status !== "stopped") {
            return yield* new BadRequest({
              detail: "Only completed or stopped answers can be promoted",
            });
          }
          if (exchange.answer.trim().length === 0)
            return yield* new BadRequest({ detail: "Exchange has no answer yet" });
          if (scope.role === "owner") {
            const result = yield* ingest.ingestSessionExchange(
              vaultId,
              sessionId,
              exchange,
              history.header.origin,
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
              buildSessionExchangeDocument(sessionId, exchange, history.header.origin),
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
            eq(sessions.placement, "standalone"),
          );
          const counts = yield* db.query((d) =>
            d
              .select({ total: sql<number>`count(*)::int` })
              .from(sessions)
              .where(where),
          );
          const rows = yield* db.query((d) =>
            d
              .select()
              .from(sessions)
              .where(where)
              .orderBy(desc(sessions.updatedAt))
              .limit(params.limit)
              .offset(params.offset),
          );
          const overviews: SessionOverview[] = [];
          for (const row of rows)
            overviews.push(
              sessionOverview(
                row,
                yield* originTitleFor(userId, vaultId, decodeSessionOrigin(row.origin)),
              ),
            );
          return pageEnvelope(overviews, params, oneTotal(counts));
        }),
      listSessionsByOrigin: (userId, vaultId, docPath) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const rows = yield* db.query((d) =>
            d
              .select()
              .from(sessions)
              .where(
                and(
                  eq(sessions.vaultId, vaultId),
                  eq(sessions.userId, userId),
                  sql`${sessions.origin}->>'doc_path' = ${docPath}`,
                ),
              )
              .orderBy(asc(sessions.createdAt)),
          );
          return yield* Effect.forEach(rows, sessionDetail);
        }),
      readSession: (userId, vaultId, sessionId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const row = yield* requireSessionOwner(userId, vaultId, sessionId);
          const detail = yield* sessionDetail(row);
          const children = yield* db.query((d) =>
            d
              .select()
              .from(sessions)
              .where(
                and(
                  eq(sessions.vaultId, vaultId),
                  eq(sessions.userId, userId),
                  sql`${sessions.origin}->>'kind' = 'answer'`,
                  sql`${sessions.origin}->>'session_id' = ${sessionId}`,
                ),
              )
              .orderBy(asc(sessions.createdAt)),
          );
          const threads = yield* Effect.forEach(children, sessionDetail);
          return {
            id: sessionId,
            kind: kindFor(row),
            events: detail.events,
            origin_title: detail.session.origin_title,
            threads,
          };
        }),
      readMarkdown: (userId, vaultId, sessionId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          return renderSessionMarkdown(
            projectSession(yield* ownedHistory(userId, vaultId, sessionId)),
          );
        }),
      readPublication,
    } satisfies SessionsServiceShape;
  }),
);
