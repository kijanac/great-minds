import { randomUUID } from "node:crypto";

import {
  Citation,
  CurrentAuth,
  type Permission,
  SearchHit,
  SessionId,
  SourceQuery,
  SourceQueryPage,
  Uuid,
} from "@great-minds/domain";
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { AuthService, keyRefusal, modelRefusal } from "./auth.ts";
import { AppConfig } from "./config.ts";
import { DocumentsService } from "./documents.ts";
import { SessionExportsService } from "./publication/service.ts";
import { QueryService } from "./query.ts";
import { RepliesService } from "./replies.ts";
import { SessionsService } from "./sessions.ts";
import { SourcesService } from "./sources.ts";
import { VaultAccessService, VaultsService } from "./vaults.ts";
import { WikiService } from "./wiki.ts";

class ToolFailed extends Schema.TaggedError<ToolFailed>()("ToolFailed", {
  message: Schema.String,
}) {}

class KeyRefused extends Schema.Error<KeyRefused>("KeyRefused")({
  ...McpSchema.McpErrorBase.fields,
  _tag: Schema.tag("KeyRefused"),
  code: Schema.tag(-32003),
}) {}

const failed = (error: { readonly detail: string } | { readonly message: string }) =>
  new ToolFailed({ message: "detail" in error ? error.detail : error.message });

const vaultId = Uuid.annotate({ description: "Vault id, from list_vaults" });
const pageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }));

const ListVaults = Tool.make("list_vaults", {
  description: "List the vaults this key can reach. Every other tool takes one of their ids.",
  success: Schema.Struct({
    vaults: Schema.Array(Schema.Struct({ id: Uuid, name: Schema.String })),
  }),
  failure: ToolFailed,
  dependencies: [CurrentAuth],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const SearchVault = Tool.make("search_vault", {
  description:
    "Search a vault's sources and wiki articles for passages about a subject. Returns the best-matching passages with their document path; read a whole document with read_document.",
  parameters: Schema.Struct({
    vault_id: vaultId,
    query: Schema.String,
    path: Schema.optionalKey(Schema.String).annotate({
      description: "Only search inside this document",
    }),
  }),
  success: Schema.Struct({ hits: Schema.Array(SearchHit) }),
  failure: ToolFailed,
  dependencies: [CurrentAuth],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const ReadDocument = Tool.make("read_document", {
  description:
    "Read a whole article (wiki/<slug>.md) or source (raw/...md) by its path. Articles cite their sources as markdown links and footnotes.",
  parameters: Schema.Struct({ vault_id: vaultId, path: Schema.String }),
  success: Schema.Struct({
    path: Schema.String,
    title: Schema.NullOr(Schema.String),
    body: Schema.String,
    archived: Schema.Boolean,
    superseded_by: Schema.NullOr(Schema.String),
  }),
  failure: ToolFailed,
  dependencies: [CurrentAuth],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const ListArticles = Tool.make("list_articles", {
  description:
    "List a vault's wiki articles, optionally only those whose title or summary contains some text.",
  parameters: Schema.Struct({
    vault_id: vaultId,
    contains: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(pageLimit),
    offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  success: Schema.Struct({
    total: Schema.Number,
    articles: Schema.Array(
      Schema.Struct({ path: Schema.String, title: Schema.String, summary: Schema.String }),
    ),
  }),
  failure: ToolFailed,
  dependencies: [CurrentAuth],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const QuerySources = Tool.make("query_sources", {
  description:
    "Filter a vault's sources by metadata: tags, author, genre, published date range, and the vault's own metadata fields. Returns a page of sources with their metadata and the total that match; page with offset. For questions about content, use search_vault instead.",
  parameters: Schema.Struct({ vault_id: vaultId, ...SourceQuery.fields }),
  success: SourceQueryPage,
  failure: ToolFailed,
  dependencies: [CurrentAuth],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const ListSessions = Tool.make("list_sessions", {
  description: "List a vault's question-and-answer sessions, newest first.",
  parameters: Schema.Struct({ vault_id: vaultId, limit: Schema.optionalKey(pageLimit) }),
  success: Schema.Struct({
    sessions: Schema.Array(
      Schema.Struct({ id: SessionId, question: Schema.String, updated_at: Schema.String }),
    ),
  }),
  failure: ToolFailed,
  dependencies: [CurrentAuth],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const ReadSession = Tool.make("read_session", {
  description: "Read a session's questions and answers as markdown.",
  parameters: Schema.Struct({ vault_id: vaultId, session_id: SessionId }),
  success: Schema.Struct({ markdown: Schema.String }),
  failure: ToolFailed,
  dependencies: [CurrentAuth],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const Ask = Tool.make("ask", {
  description:
    "Ask Great Minds' research agent a question about a vault. It searches and reads the vault, then answers in prose with numbered citations. Pass session_id to ask a follow-up in the same session. Answers use paid models and take a minute or more.",
  parameters: Schema.Struct({
    vault_id: vaultId,
    question: Schema.String,
    session_id: Schema.optionalKey(SessionId),
  }),
  success: Schema.Struct({
    answer: Schema.String,
    citations: Schema.Array(Citation),
    session_id: SessionId,
  }),
  failure: ToolFailed,
  dependencies: [CurrentAuth],
}).annotate(Tool.OpenWorld, false);

const GreatMindsTools = Toolkit.make(
  ListVaults,
  SearchVault,
  ReadDocument,
  ListArticles,
  QuerySources,
  ListSessions,
  ReadSession,
  Ask,
);

const toolPermissions: Readonly<Record<string, Permission>> = {
  list_vaults: "read",
  search_vault: "read",
  read_document: "read",
  list_articles: "read",
  query_sources: "read",
  list_sessions: "read",
  read_session: "read",
  ask: "ask",
};

const modelTools: ReadonlySet<string> = new Set(["search_vault", "ask"]);

const newUuid = () => Uuid.make(randomUUID(), { disableChecks: true });

const ToolHandlers = GreatMindsTools.toLayer(
  Effect.gen(function* () {
    const vaults = yield* VaultsService;
    const access = yield* VaultAccessService;
    const queries = yield* QueryService;
    const documents = yield* DocumentsService;
    const wiki = yield* WikiService;
    const sessions = yield* SessionsService;
    const sources = yield* SourcesService;
    const exports = yield* SessionExportsService;
    const replies = yield* RepliesService;
    const userId = Effect.map(CurrentAuth, (current) => current.user_id);

    return GreatMindsTools.of({
      list_vaults: () =>
        Effect.gen(function* () {
          const page = yield* vaults.listVaults(yield* userId, { limit: 200, offset: 0 });
          return { vaults: page.items.map((vault) => ({ id: vault.id, name: vault.name })) };
        }),
      search_vault: ({ vault_id, query, path }) =>
        Effect.gen(function* () {
          const user = yield* userId;
          yield* access.requireMember(user, vault_id);
          return { hits: yield* queries.search(user, vault_id, query, path) };
        }).pipe(Effect.mapError(failed)),
      read_document: ({ vault_id, path }) =>
        Effect.gen(function* () {
          const document = yield* documents.readDocument(yield* userId, vault_id, path);
          return {
            path: document.article.file_path,
            title: document.article.title,
            body: document.body,
            archived: document.archived,
            superseded_by: document.superseded_by,
          };
        }).pipe(Effect.mapError(failed)),
      list_articles: ({ vault_id, contains, limit, offset }) =>
        Effect.gen(function* () {
          const page = yield* wiki.listArticles(yield* userId, vault_id, {
            limit: limit ?? 50,
            offset: offset ?? 0,
            ...(contains === undefined ? {} : { contains }),
          });
          return {
            total: page.pagination.total,
            articles: page.items.map((article) => ({
              path: article.file_path,
              title: article.title,
              summary: article.precis,
            })),
          };
        }).pipe(Effect.mapError(failed)),
      query_sources: ({ vault_id, ...query }) =>
        Effect.gen(function* () {
          return yield* sources.querySources(yield* userId, vault_id, query);
        }).pipe(Effect.mapError(failed)),
      list_sessions: ({ vault_id, limit }) =>
        Effect.gen(function* () {
          const page = yield* sessions.listSessions(yield* userId, vault_id, {
            limit: limit ?? 20,
            offset: 0,
          });
          return {
            sessions: page.items.map((session) => ({
              id: session.id,
              question: session.query,
              updated_at: session.updated_at.toISOString(),
            })),
          };
        }).pipe(Effect.mapError(failed)),
      read_session: ({ vault_id, session_id }) =>
        Effect.gen(function* () {
          return { markdown: yield* exports.readMarkdown(yield* userId, vault_id, session_id) };
        }).pipe(Effect.mapError(failed)),
      ask: ({ vault_id, question, session_id }) =>
        Effect.gen(function* () {
          const user = yield* userId;
          const created = yield* replies.create(user, vault_id, {
            question,
            reply_id: newUuid(),
            exchange_id: newUuid(),
            origin_scope: "vault",
            session:
              session_id === undefined
                ? {
                    kind: "new",
                    idempotency_key: newUuid(),
                    conversation_kind: "session",
                    origin_scope: "vault",
                  }
                : { kind: "existing", id: session_id },
          });
          const reply = yield* replies.settled(user, vault_id, created.reply_id);
          if (reply.status !== "completed")
            return yield* new ToolFailed({
              message: `The answer ${reply.status}${reply.error === null ? "" : `: ${reply.error}`}`,
            });
          return {
            answer: reply.answer.trim(),
            citations: reply.citations,
            session_id: reply.session_id,
          };
        }).pipe(Effect.mapError((error) => (error._tag === "ToolFailed" ? error : failed(error)))),
    });
  }),
);

const KeyPermissions = McpServer.middleware((effect, { target }) =>
  Effect.gen(function* () {
    const current = yield* CurrentAuth;
    const refusal =
      keyRefusal(current, toolPermissions[target] ?? "account") ??
      (modelTools.has(target) ? modelRefusal(current) : undefined);
    if (refusal !== undefined) return yield* new KeyRefused({ message: refusal });
    return yield* effect;
  }),
);

const unauthorized = HttpServerResponse.jsonUnsafe(
  { detail: "Sign in with a Great Minds API key: Authorization: Bearer <key>" },
  { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="great-minds"' } },
);

const BearerAuth = HttpRouter.middleware<{ provides: CurrentAuth }>()(
  Effect.gen(function* () {
    const auth = yield* AuthService;
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const header = request.headers["authorization"] ?? "";
        const token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
        if (token === undefined) return unauthorized;
        const current = yield* Effect.result(auth.authenticateBearer(token.trim()));
        if (current._tag === "Failure") return unauthorized;
        return yield* Effect.provideService(effect, CurrentAuth, current.success);
      });
  }),
);

export const McpRoutesLive = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    McpServer.layerHttp({
      name: "great-minds",
      version: "1",
      description: "Search, read and ask a Great Minds vault",
      path: "/v1/mcp",
      protocols: [
        McpProtocol.v2026_07_28,
        McpProtocol.v2025_11_25,
        McpProtocol.v2025_06_18,
        McpProtocol.v2025_03_26,
      ],
      allowedOrigins: config.corsOrigins,
      allowSessionTermination: true,
      registrations: McpServer.toolkit(GreatMindsTools).pipe(
        Layer.provide(KeyPermissions.layer),
        Layer.provide(ToolHandlers),
      ),
    }),
  ),
).pipe(Layer.provide(BearerAuth.layer));
