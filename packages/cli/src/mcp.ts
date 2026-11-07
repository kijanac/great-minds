import { errorMessage, followReply, newUuid, replyRequest } from "@great-minds/client";
import { Citation, SearchHit, SessionId } from "@great-minds/domain";
import { Effect, Layer, Logger, Option, Schema, Stream } from "effect";
import * as McpProtocol from "effect/unstable/ai/McpProtocol";
import * as McpServer from "effect/unstable/ai/McpServer";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { vaultConnection } from "./commands.ts";
import type { CliFetch } from "./connection.ts";
import type { Credentials } from "./credentials.ts";

class ToolFailed extends Schema.TaggedError<ToolFailed>()("ToolFailed", {
  message: Schema.String,
}) {}

const failed = (error: unknown) => new ToolFailed({ message: errorMessage(error) });

const SearchVault = Tool.make("search_vault", {
  description:
    "Search the vault's sources and wiki articles for passages about a subject. Returns the best-matching passages with their document path; read a whole document with read_document.",
  parameters: Schema.Struct({
    query: Schema.String,
    path: Schema.optionalKey(Schema.String).annotate({
      description: "Only search inside this document",
    }),
  }),
  success: Schema.Struct({ hits: Schema.Array(SearchHit) }),
  failure: ToolFailed,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const ReadDocument = Tool.make("read_document", {
  description:
    "Read a whole article (wiki/<slug>.md) or source (raw/...md) by its path. Article text cites sources as markdown links and footnotes.",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.Struct({
    path: Schema.String,
    title: Schema.NullOr(Schema.String),
    body: Schema.String,
    archived: Schema.Boolean,
    superseded_by: Schema.NullOr(Schema.String),
  }),
  failure: ToolFailed,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const ListArticles = Tool.make("list_articles", {
  description:
    "List the vault's wiki articles, optionally only those whose title or summary contains some text.",
  parameters: Schema.Struct({
    contains: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  }),
  success: Schema.Struct({
    total: Schema.Number,
    articles: Schema.Array(
      Schema.Struct({ path: Schema.String, title: Schema.String, summary: Schema.String }),
    ),
  }),
  failure: ToolFailed,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const ListSessions = Tool.make("list_sessions", {
  description: "List recent question-and-answer sessions in the vault, newest first.",
  parameters: Schema.Struct({
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  }),
  success: Schema.Struct({
    sessions: Schema.Array(
      Schema.Struct({ id: SessionId, question: Schema.String, updated_at: Schema.String }),
    ),
  }),
  failure: ToolFailed,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const ReadSession = Tool.make("read_session", {
  description: "Read a session's questions and answers as markdown.",
  parameters: Schema.Struct({ session_id: SessionId }),
  success: Schema.Struct({ markdown: Schema.String }),
  failure: ToolFailed,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const Ask = Tool.make("ask", {
  description:
    "Ask Great Minds' research agent a question about the vault. It searches and reads the vault, then answers in prose with citations. Pass session_id to ask a follow-up in the same session. Answers call paid models and take a minute or more.",
  parameters: Schema.Struct({
    question: Schema.String,
    session_id: Schema.optionalKey(SessionId),
  }),
  success: Schema.Struct({
    answer: Schema.String,
    citations: Schema.Array(Citation),
    session_id: SessionId,
  }),
  failure: ToolFailed,
}).annotate(Tool.OpenWorld, false);

const GreatMindsTools = Toolkit.make(
  SearchVault,
  ReadDocument,
  ListArticles,
  ListSessions,
  ReadSession,
  Ask,
);

const handlers = (vault: Option.Option<string>) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<CliFetch | Credentials>();
    const connected = yield* Effect.cached(
      vaultConnection(vault).pipe(Effect.mapError(failed), Effect.provideContext(services)),
    );
    const call = <A, E>(effect: Effect.Effect<A, E, never>) => effect.pipe(Effect.mapError(failed));

    const searchVault = (query: string, path: string | undefined) =>
      Effect.gen(function* () {
        const { connection, vaultId } = yield* connected;
        const hits = yield* call(
          connection.use(
            connection.api.documents.searchVault({
              params: { vault_id: vaultId },
              query: path === undefined ? { q: query } : { q: query, path },
            }),
          ),
        );
        return { hits };
      });

    const readDocument = (path: string) =>
      Effect.gen(function* () {
        const { connection, vaultId } = yield* connected;
        const document = yield* call(
          connection.use(
            connection.api.documents.resolveDocument({
              params: { vault_id: vaultId },
              query: { path },
            }),
          ),
        );
        return {
          path: document.article.file_path,
          title: document.article.title,
          body: document.body,
          archived: document.archived,
          superseded_by: document.superseded_by,
        };
      });

    const listArticles = (contains: string | undefined, limit: number | undefined) =>
      Effect.gen(function* () {
        const { connection, vaultId } = yield* connected;
        const page = yield* call(
          connection.use(
            connection.api.wiki.listWikiArticles({
              params: { vault_id: vaultId },
              query: {
                limit: limit ?? 50,
                offset: 0,
                ...(contains === undefined ? {} : { contains }),
              },
            }),
          ),
        );
        return {
          total: page.pagination.total,
          articles: page.items.map((article) => ({
            path: article.file_path,
            title: article.title,
            summary: article.precis,
          })),
        };
      });

    const listSessions = (limit: number | undefined) =>
      Effect.gen(function* () {
        const { connection, vaultId } = yield* connected;
        const page = yield* call(
          connection.use(
            connection.api.sessions.listSessions({
              params: { vault_id: vaultId },
              query: { limit: limit ?? 20, offset: 0 },
            }),
          ),
        );
        return {
          sessions: page.items.map((session) => ({
            id: session.id,
            question: session.query,
            updated_at: session.updated_at.toISOString(),
          })),
        };
      });

    const readSession = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const { connection, vaultId } = yield* connected;
        const markdown = yield* call(
          connection.use(
            connection.api.sessions.readSessionMarkdown({
              params: { vault_id: vaultId, session_id: sessionId },
            }),
          ),
        );
        return { markdown };
      });

    const ask = (question: string, sessionId: SessionId | undefined) =>
      Effect.gen(function* () {
        const { connection, vaultId } = yield* connected;
        const created = yield* call(
          connection.use(
            connection.api.replies.createReply({
              params: { vault_id: vaultId },
              payload: replyRequest({
                question,
                exchangeId: newUuid(),
                originScope: "vault",
                conversation:
                  sessionId === undefined
                    ? { kind: "new", conversationKind: "session", idempotencyKey: newUuid() }
                    : { kind: "existing", id: sessionId },
              }),
            }),
          ),
        );
        const last = yield* call(
          Stream.runLast(connection.follow(followReply(connection.api, vaultId, created.reply_id))),
        );
        if (Option.isNone(last))
          return yield* new ToolFailed({ message: "the answer stream ended before it finished" });
        const reply = last.value;
        if (reply.status !== "completed")
          return yield* new ToolFailed({
            message: `the answer ${reply.status}${reply.error === null ? "" : `: ${reply.error}`}`,
          });
        return {
          answer: reply.answer.trim(),
          citations: reply.citations,
          session_id: reply.session_id,
        };
      });

    return GreatMindsTools.of({
      search_vault: ({ query, path }) => searchVault(query, path),
      read_document: ({ path }) => readDocument(path),
      list_articles: ({ contains, limit }) => listArticles(contains, limit),
      list_sessions: ({ limit }) => listSessions(limit),
      read_session: ({ session_id }) => readSession(session_id),
      ask: ({ question, session_id }) => ask(question, session_id),
    });
  });

export const serveMcp = (input: { readonly vault: Option.Option<string> }) =>
  Layer.launch(
    McpServer.toolkit(GreatMindsTools).pipe(
      Layer.provide(GreatMindsTools.toLayer(handlers(input.vault))),
      Layer.provide(
        McpServer.layerStdio({
          name: "great-minds",
          version: "0.1.0",
          description: "Search, read and ask a Great Minds vault",
          protocols: [
            McpProtocol.v2025_11_25,
            McpProtocol.v2025_06_18,
            McpProtocol.v2025_03_26,
            McpProtocol.v2024_11_05,
          ],
        }),
      ),
      Layer.provide(Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)])),
    ),
  );
