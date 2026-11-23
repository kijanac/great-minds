import { Database, replies, sessions, userDocuments } from "@great-minds/database";
import {
  BadRequest,
  citationsOf,
  composeAnchoredQuestion,
  Conflict,
  Forbidden,
  isReplyPending,
  NotFound,
  ServiceUnavailable,
  SessionActivity,
  type PageParams,
  type PromoteExchangeResponse,
  type SessionContent,
  type SessionDetail,
  type SessionExchange,
  type SessionId,
  type SessionOverview,
  type SessionPage,
  type SessionResponse,
  type Uuid,
} from "@great-minds/domain";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer, Result } from "effect";

import { acceptedRequestFor } from "./conversation-history/admission.ts";
import {
  type ConversationHistory,
  hasUsableAnswer,
  type SettledOrPendingAttempt,
  verifyHistoryReceipt,
} from "./conversation-history/history.ts";
import { acknowledgedReceipt, sessionReceipt } from "./conversation-history/rows.ts";
import {
  isPublished,
  projectSession,
  type PublishedExchange,
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
  readonly typedQuestion: string;
};

type SessionsServiceShape = {
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
    exchangeId: Uuid,
  ) => Effect.Effect<PromoteExchangeResponse, BadRequest | Conflict | SessionReadError>;
  readonly listSessions: (
    userId: Uuid,
    vaultId: Uuid,
    params: PageParams,
  ) => Effect.Effect<SessionPage, Forbidden>;
  readonly listSessionsByOrigin: (
    userId: Uuid,
    vaultId: Uuid,
    docPath: string,
  ) => Effect.Effect<readonly SessionDetail[], SessionReadError>;
  readonly readSession: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
  ) => Effect.Effect<SessionResponse, SessionReadError>;
  readonly readPublication: (
    userId: Uuid,
    vaultId: Uuid,
    sessionId: SessionId,
  ) => Effect.Effect<readonly PublishedExchange[], SessionReadError>;
};

export class SessionsService extends Context.Service<SessionsService, SessionsServiceShape>()(
  "@great-minds/server/SessionsService",
) {}

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

const requireAttempt = (history: ConversationHistory, replyId: Uuid) => {
  const attempt = attemptFor(history, replyId);
  return attempt === undefined
    ? Effect.fail(new NotFound({ detail: "Reply not found in conversation history" }))
    : Effect.succeed(attempt);
};

const questionOf = (history: ConversationHistory, attempt: SettledOrPendingAttempt) => {
  const passage = history.header.origin?.passage ?? null;
  return attempt.accepted.parent_reply_id === null && passage !== null
    ? composeAnchoredQuestion(passage, attempt.accepted.question)
    : attempt.accepted.question;
};

const makeSessions = Effect.gen(function* () {
  const db = yield* Database;
  const access = yield* VaultAccessService;
  const histories = yield* HistoryStore;
  const logger = yield* StructuredLogger;
  const sourceDocuments = yield* SourceDocumentsService;
  const proposals = yield* ProposalsService;
  const ingest = yield* IngestService;

  const unavailable = () =>
    new ServiceUnavailable({
      detail: "Conversation history is unavailable; no content has been discarded",
    });

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
      const file = yield* histories.read(
        { vault_id: row.vaultId, session_id: row.id },
        yield* acknowledgedReceipt(row),
      );
      return file.history;
    }).pipe(
      Effect.tapError((error) =>
        logger.warn("conversation_history_unavailable", {
          session_id: row.id,
          vault_id: row.vaultId,
          error_tag: error._tag,
          error_message: error.message,
        }),
      ),
      Effect.mapError(unavailable),
    );

  const confirmAccess = (userId: Uuid, vaultId: Uuid, ids: readonly SessionId[]) =>
    Effect.gen(function* () {
      if (ids.length > 0) {
        const owned = yield* db.query((d) =>
          d
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              and(
                eq(sessions.vaultId, vaultId),
                eq(sessions.userId, userId),
                inArray(sessions.id, [...ids]),
              ),
            ),
        );
        if (owned.length !== new Set(ids).size)
          return yield* new NotFound({ detail: "Session not found" });
      }
      yield* access.requireMember(userId, vaultId);
    });

  const confirmReceipt = (row: SessionRow, history: ConversationHistory) =>
    Effect.gen(function* () {
      const receipt = sessionReceipt(row);
      if (
        receipt === undefined ||
        history.header.author_id !== row.userId ||
        Result.isFailure(verifyHistoryReceipt(history, receipt))
      )
        return yield* unavailable();
    });

  const ownedHistory = (userId: Uuid, vaultId: Uuid, sessionId: SessionId) =>
    Effect.gen(function* () {
      yield* access.requireMember(userId, vaultId);
      const history = yield* loadHistory(yield* requireSessionOwner(userId, vaultId, sessionId));
      yield* confirmReceipt(yield* requireSessionOwner(userId, vaultId, sessionId), history);
      yield* access.requireMember(userId, vaultId);
      return history;
    });

  const readContent = (row: SessionRow) =>
    Effect.gen(function* () {
      const history = yield* loadHistory(row);
      const active = yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const [current] = yield* tx
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.id, row.id),
                eq(sessions.vaultId, row.vaultId),
                eq(sessions.userId, row.userId),
              ),
            )
            .for("share");
          if (current === undefined) return yield* new NotFound({ detail: "Session not found" });
          yield* confirmReceipt(current, history);
          const live = yield* tx
            .select()
            .from(replies)
            .where(
              and(
                eq(replies.sessionId, row.id),
                eq(replies.vaultId, row.vaultId),
                inArray(replies.status, SessionActivity.fields.status.literals),
              ),
            );
          return live[0];
        }),
      );
      const exchanges = projectSession(history);
      if (
        history.turns.some(
          (turn) => turn.latest.settlement === null && turn.latest.accepted.reply_id !== active?.id,
        )
      )
        return yield* unavailable();
      if (active === undefined) return { exchanges, activity: null } satisfies SessionContent;
      if (active.userId !== row.userId) return yield* unavailable();
      const saved = exchanges.find((exchange) => exchange.reply_id === active.id);
      const replace = (target: SessionExchange, next: SessionExchange) =>
        exchanges.map((exchange) => (exchange === target ? next : exchange));
      if (saved !== undefined && saved.status !== "running")
        return {
          exchanges: replace(saved, { ...saved, version: active.version }),
          activity: { reply_id: active.id, status: "settling" },
        } satisfies SessionContent;
      if (!isReplyPending(active.status)) return yield* unavailable();
      const activity = { reply_id: active.id, status: active.status };
      if (saved !== undefined)
        return {
          exchanges: replace(saved, {
            ...saved,
            version: active.version,
            answer: active.answer,
            citations: citationsOf(active.answer),
            sources: active.sources,
          }),
          activity,
        } satisfies SessionContent;
      if (active.status !== "admitting") return yield* unavailable();
      const request = yield* acceptedRequestFor(active).pipe(Effect.mapError(unavailable));
      const pending: SessionExchange = {
        exchange_id: request.command.exchange_id,
        reply_id: active.id,
        version: active.version,
        status: "running",
        error: null,
        query: request.command.question,
        answer: "",
        citations: [],
        sources: [],
        ts: request.accepted_at,
      };
      const previous = exchanges.find((exchange) => exchange.exchange_id === pending.exchange_id);
      return {
        exchanges: previous === undefined ? [...exchanges, pending] : replace(previous, pending),
        activity,
      } satisfies SessionContent;
    });

  const originTitles = (userId: Uuid, vaultId: Uuid, rows: readonly SessionRow[]) =>
    Effect.gen(function* () {
      const parents = new Set<SessionId>();
      const personal = new Set<string>();
      const vault = new Set<string>();
      for (const { origin } of rows) {
        if (origin === null) continue;
        if (origin.kind === "answer") parents.add(origin.session_id);
        else (origin.origin_scope === "personal" ? personal : vault).add(origin.doc_path);
      }
      const known = new Map(rows.map((row) => [row.id, row.query]));
      const missing = [...parents].filter((id) => !known.has(id));
      const [questions, references, sources] = yield* Effect.all(
        [
          missing.length === 0
            ? Effect.succeed([])
            : db.query((d) =>
                d
                  .select({ id: sessions.id, query: sessions.query })
                  .from(sessions)
                  .where(
                    and(
                      eq(sessions.vaultId, vaultId),
                      eq(sessions.userId, userId),
                      inArray(sessions.id, missing),
                    ),
                  ),
              ),
          personal.size === 0
            ? Effect.succeed([])
            : db.query((d) =>
                d
                  .select({ path: userDocuments.filePath, title: userDocuments.title })
                  .from(userDocuments)
                  .where(
                    and(
                      eq(userDocuments.userId, userId),
                      inArray(userDocuments.filePath, [...personal]),
                    ),
                  ),
              ),
          sourceDocuments.titlesByPath(vaultId, [...vault]),
        ],
        { concurrency: 3 },
      );
      for (const question of questions) known.set(question.id, question.query);
      const referenceTitles = new Map(references.map((row) => [row.path, row.title]));
      return (row: SessionRow): SessionOverview => {
        const origin = row.origin;
        return {
          id: row.id,
          query: row.query,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
          user_id: row.userId,
          origin,
          origin_title:
            origin === null
              ? null
              : origin.kind === "answer"
                ? (known.get(origin.session_id) ?? null)
                : origin.origin_scope === "personal"
                  ? (referenceTitles.get(origin.doc_path) ?? null)
                  : (sources.get(origin.doc_path) ?? null),
        };
      };
    });

  const sessionDetail = (row: SessionRow, session: SessionOverview) =>
    readContent(row).pipe(
      Effect.map((content): SessionDetail => ({ availability: "available", session, ...content })),
      Effect.catchTag("ServiceUnavailable", (error) =>
        Effect.succeed<SessionDetail>({
          availability: "unavailable",
          session,
          detail: error.detail,
        }),
      ),
    );

  const readPublication = (userId: Uuid, vaultId: Uuid, sessionId: SessionId) =>
    ownedHistory(userId, vaultId, sessionId).pipe(
      Effect.map((history) => projectSession(history).filter(isPublished)),
    );

  return {
    readReplyQuestion: (userId, vaultId, sessionId, replyId) =>
      Effect.gen(function* () {
        const history = yield* ownedHistory(userId, vaultId, sessionId);
        return questionOf(history, yield* requireAttempt(history, replyId));
      }),
    readTranscript: (userId, vaultId, sessionId, replyId) =>
      Effect.gen(function* () {
        let history = yield* ownedHistory(userId, vaultId, sessionId);
        const attempt = yield* requireAttempt(history, replyId);
        const question = questionOf(history, attempt);
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
          if (!hasUsableAnswer(previous) || previous.settlement.context_messages === null) {
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
          typedQuestion: attempt.accepted.question,
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
          (candidate) => candidate.exchange_id === exchangeId,
        );
        if (exchange === undefined)
          return yield* new NotFound({ detail: "Exchange not found in session" });
        if (!isPublished(exchange)) {
          return yield* new BadRequest({
            detail: "Only completed or stopped answers can be promoted",
          });
        }
        if (exchange.answer.trim().length === 0)
          return yield* new BadRequest({ detail: "Exchange has no answer yet" });
        const source = yield* sourceDocuments.admit(vaultId, sourceId, dest);
        if (scope.role === "owner") {
          const result = yield* ingest.ingestSessionExchange(
            source,
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
        const proposal = yield* proposals.createRendered(source, userId, {
          contentType: "session",
          title: null,
          author: null,
          rendered: identifySourceMarkdown(
            buildSessionExchangeDocument(sessionId, exchange, history.header.origin),
            sourceId,
          ),
        });
        return {
          mode: "proposed" as const,
          path: source.filePath,
          title: null,
          document_id: null,
          proposal_id: proposal.id,
        };
      }),
    listSessions: (userId, vaultId, params) =>
      Effect.gen(function* () {
        yield* access.requireMember(userId, vaultId);
        const where = and(eq(sessions.vaultId, vaultId), eq(sessions.userId, userId));
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
        const overview = yield* originTitles(userId, vaultId, rows);
        return pageEnvelope(rows.map(overview), params, oneTotal(counts));
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
        const overview = yield* originTitles(userId, vaultId, rows);
        const details = yield* Effect.forEach(rows, (row) => sessionDetail(row, overview(row)), {
          concurrency: 4,
        });
        yield* confirmAccess(
          userId,
          vaultId,
          rows.map((row) => row.id),
        );
        return details;
      }),
    readSession: (userId, vaultId, sessionId) =>
      Effect.gen(function* () {
        yield* access.requireMember(userId, vaultId);
        const row = yield* requireSessionOwner(userId, vaultId, sessionId);
        const content = yield* readContent(row);
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
        const overview = yield* originTitles(userId, vaultId, [row, ...children]);
        const threads = yield* Effect.forEach(
          children,
          (child) => sessionDetail(child, overview(child)),
          { concurrency: 4 },
        );
        yield* confirmAccess(userId, vaultId, [sessionId, ...children.map((child) => child.id)]);
        return {
          availability: "available" as const,
          session: overview(row),
          ...content,
          threads,
        };
      }),
    readPublication,
  } satisfies SessionsServiceShape;
});

export const SessionsServiceLive = Layer.effect(SessionsService, makeSessions);
