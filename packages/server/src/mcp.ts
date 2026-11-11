import { randomUUID } from "node:crypto";

import {
  Citation,
  Chunk,
  ChunkRangeQuery,
  CurrentAuth,
  DocResponse,
  LinkedArticles,
  LinkQuery,
  PageParamsQuery,
  SearchQuery,
  SessionPage,
  VaultPage,
  WikiArticlePage,
  WikiListQuery,
  type EndpointName,
  endpointPermissions,
  modelEndpoints,
  CompileRequest,
  JobListQuery,
  JobPage,
  JobResponse,
  SearchHit,
  PublicationPaper,
  SessionExport,
  SessionExportSelection,
  SessionResponse,
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
import { JobsService } from "./jobs.ts";
import { UrlIngestService } from "./url-ingest.ts";
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
const pageFields = {
  limit: Schema.optionalKey(Schema.toType(PageParamsQuery.fields.limit)),
  offset: Schema.optionalKey(Schema.toType(PageParamsQuery.fields.offset)),
};
const page = (query: { readonly limit?: number; readonly offset?: number }) => ({
  limit: query.limit ?? 50,
  offset: query.offset ?? 0,
});

const ListVaults = Tool.make("list_vaults", {
  description: "List the vaults this key can reach. Every other tool takes one of their ids.",
  parameters: Schema.Struct(pageFields),
  success: VaultPage,
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
    query: SearchQuery.fields.q,
    path: SearchQuery.fields.path.annotate({
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
  success: DocResponse,
  failure: ToolFailed,
  dependencies: [CurrentAuth],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const ReadChunks = Tool.make("read_chunks", {
  description:
    "Read an inclusive range of indexed document chunks, up to 100. Use the chunk_index returned by search_vault. Negative starts clamp to zero.",
  parameters: Schema.Struct({
    vault_id: vaultId,
    path: ChunkRangeQuery.fields.path,
    start: Schema.toType(ChunkRangeQuery.fields.start),
    end: Schema.toType(ChunkRangeQuery.fields.end),
  }),
  success: Schema.Struct({ chunks: Schema.Array(Chunk) }),
  failure: ToolFailed,
  dependencies: [CurrentAuth],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const ReadLinks = Tool.make("read_links", {
  description: "Read a wiki article's outgoing, incoming and related articles.",
  parameters: Schema.Struct({ vault_id: vaultId, ...LinkQuery.fields }),
  success: LinkedArticles,
  failure: ToolFailed,
  dependencies: [CurrentAuth],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const ListArticles = Tool.make("list_articles", {
  description:
    "List wiki articles by title/summary text, tag or Update id. Sort by title (default), linked or recent. Recent order cannot be combined with filters. Results include file_path and pagination; use offset for later pages.",
  parameters: Schema.Struct({
    vault_id: vaultId,
    ...WikiListQuery.fields,
    ...pageFields,
    sort: Schema.optionalKey(Schema.Literals(["title", "linked", "recent"])),
  }).check(
    Schema.makeFilter(
      (query) =>
        query.sort !== "recent" ||
        (query.contains === undefined && query.tag === undefined && query.run === undefined) ||
        "Recent article order cannot be combined with filters.",
    ),
  ),
  success: WikiArticlePage,
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
  parameters: Schema.Struct({ vault_id: vaultId, ...pageFields }),
  success: SessionPage,
  failure: ToolFailed,
  dependencies: [CurrentAuth],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const ReadSession = Tool.make("read_session", {
  description:
    "Read a saved conversation; the result is wrapped in data. Default json returns structured events and attached notes: each exchange has exId, query (user) and answer (assistant). Markdown returns prose without PDF rendering. PDF returns base64 pdf bytes plus matching Markdown; decode the bytes to save a file. For Markdown/PDF, optionally select messages using session_id, exchange_id (exId), and role; omit messages for everything. Does not publish, store an artifact, or call a model.",
  parameters: Schema.Struct({
    vault_id: vaultId,
    session_id: SessionId,
    format: Schema.optionalKey(Schema.Literals(["json", "markdown", "pdf"])),
    ...SessionExportSelection.fields,
    paper: Schema.optionalKey(PublicationPaper).annotate({
      description: "PDF paper size; defaults to a4. Ignored for other formats.",
    }),
  }).check(
    Schema.makeFilter(
      (input) =>
        input.messages === undefined ||
        input.format === "markdown" ||
        input.format === "pdf" ||
        "Message selection requires format markdown or pdf.",
    ),
  ),
  success: Schema.Struct({
    data: Schema.Union([
      SessionResponse,
      SessionExport,
      Schema.Struct({ markdown: Schema.String }),
    ]),
  }),
  failure: ToolFailed,
  dependencies: [CurrentAuth],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const ListJobs = Tool.make("list_jobs", {
  description:
    "List Updates and uploads, newest first. Filter by status, including active; page with limit and offset.",
  parameters: Schema.Struct({ vault_id: vaultId, ...JobListQuery.fields, ...pageFields }),
  success: JobPage,
  failure: ToolFailed,
  dependencies: [CurrentAuth],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const ReadJob = Tool.make("read_job", {
  description:
    "Read an Update or upload's status, stages, warnings and error. Does not wait for completion.",
  parameters: Schema.Struct({ vault_id: vaultId, job_id: Uuid }),
  success: JobResponse,
  failure: ToolFailed,
  dependencies: [CurrentAuth],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

const StartUpdate = Tool.make("start_update", {
  description:
    "Start a paid Update of the vault. Owner only. Returns the accepted job immediately; use read_job to monitor it. This starts new work, not a retry of an old job.",
  parameters: Schema.Struct({ vault_id: vaultId }),
  success: JobResponse,
  failure: ToolFailed,
  dependencies: [CurrentAuth],
}).annotate(Tool.OpenWorld, false);

const CancelJob = Tool.make("cancel_job", {
  description:
    "Request cancellation of an Update or upload. Owner only. Completed or missing jobs are unchanged; read_job confirms the current state.",
  parameters: Schema.Struct({ vault_id: vaultId, job_id: Uuid }),
  success: Schema.Struct({ job_id: Uuid }),
  failure: ToolFailed,
  dependencies: [CurrentAuth],
}).annotate(Tool.OpenWorld, false);

const RetryUrlJob = Tool.make("retry_url_job", {
  description:
    "Retry a failed or cancelled URL import. Owner only; uses paid models. next_job_id must be a fresh UUID; reuse it when repeating this same retry request. Returns the accepted job immediately. Not for file uploads or manual Updates.",
  parameters: Schema.Struct({
    vault_id: vaultId,
    job_id: Uuid,
    next_job_id: CompileRequest.fields.job_id,
  }),
  success: JobResponse,
  failure: ToolFailed,
  dependencies: [CurrentAuth],
}).annotate(Tool.OpenWorld, false);

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
  ReadChunks,
  ReadLinks,
  ListArticles,
  QuerySources,
  ListSessions,
  ReadSession,
  ListJobs,
  ReadJob,
  StartUpdate,
  CancelJob,
  RetryUrlJob,
  Ask,
);

const toolEndpoints: Readonly<Record<string, EndpointName>> = {
  list_vaults: "listVaults",
  search_vault: "searchVault",
  read_document: "resolveDocument",
  read_chunks: "readChunks",
  read_links: "readLinks",
  list_articles: "listWikiArticles",
  query_sources: "querySources",
  list_sessions: "listSessions",
  read_session: "readSession",
  list_jobs: "listJobs",
  read_job: "getJob",
  start_update: "requestCompile",
  cancel_job: "cancelCompile",
  retry_url_job: "retryUrlJob",
  ask: "createReply",
};

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
    const jobs = yield* JobsService;
    const urlIngest = yield* UrlIngestService;
    const userId = Effect.map(CurrentAuth, (current) => current.user_id);

    return GreatMindsTools.of({
      list_vaults: (query) =>
        Effect.gen(function* () {
          return yield* vaults.listVaults(yield* userId, page(query));
        }),
      search_vault: ({ vault_id, query, path }) =>
        Effect.gen(function* () {
          const user = yield* userId;
          yield* access.requireMember(user, vault_id);
          return { hits: yield* queries.search(user, vault_id, query, path) };
        }).pipe(Effect.mapError(failed)),
      read_document: ({ vault_id, path }) =>
        Effect.gen(function* () {
          return yield* documents.readDocument(yield* userId, vault_id, path);
        }).pipe(Effect.mapError(failed)),
      read_chunks: ({ vault_id, ...query }) =>
        Effect.gen(function* () {
          return { chunks: yield* documents.readChunks(yield* userId, vault_id, query) };
        }).pipe(Effect.mapError(failed)),
      read_links: ({ vault_id, ...query }) =>
        Effect.gen(function* () {
          return yield* documents.readLinks(yield* userId, vault_id, query);
        }).pipe(Effect.mapError(failed)),
      list_articles: ({ vault_id, sort, ...query }) =>
        Effect.gen(function* () {
          const user = yield* userId;
          if (sort === "recent") return yield* wiki.listRecent(user, vault_id, page(query));
          return yield* wiki.listArticles(user, vault_id, {
            ...query,
            ...page(query),
            sort: sort ?? "title",
          });
        }).pipe(Effect.mapError(failed)),
      query_sources: ({ vault_id, ...query }) =>
        Effect.gen(function* () {
          return yield* sources.querySources(yield* userId, vault_id, query);
        }).pipe(Effect.mapError(failed)),
      list_sessions: ({ vault_id, ...query }) =>
        Effect.gen(function* () {
          return yield* sessions.listSessions(yield* userId, vault_id, page(query));
        }).pipe(Effect.mapError(failed)),
      read_session: ({ vault_id, session_id, format = "json", paper = "a4", ...selection }) =>
        Effect.gen(function* () {
          const user = yield* userId;
          if (format === "json") return yield* sessions.readSession(user, vault_id, session_id);
          if (format === "pdf")
            return yield* exports.prepare(user, vault_id, session_id, { ...selection, paper });
          return { markdown: yield* exports.readMarkdown(user, vault_id, session_id, selection) };
        }).pipe(
          Effect.map((data) => ({ data })),
          Effect.mapError(failed),
        ),
      list_jobs: ({ vault_id, ...query }) =>
        Effect.gen(function* () {
          return yield* jobs.list(yield* userId, vault_id, { ...query, ...page(query) });
        }).pipe(Effect.mapError(failed)),
      read_job: ({ vault_id, job_id }) =>
        Effect.gen(function* () {
          return yield* jobs.get(yield* userId, vault_id, job_id);
        }).pipe(Effect.mapError(failed)),
      start_update: ({ vault_id }) =>
        Effect.gen(function* () {
          return yield* jobs.requestCompile(yield* userId, vault_id, newUuid());
        }).pipe(Effect.mapError(failed)),
      cancel_job: ({ vault_id, job_id }) =>
        Effect.gen(function* () {
          yield* jobs.cancelCompile(yield* userId, vault_id, job_id);
          return { job_id };
        }).pipe(Effect.mapError(failed)),
      retry_url_job: ({ vault_id, job_id, next_job_id }) =>
        Effect.gen(function* () {
          return yield* urlIngest.retry(yield* userId, vault_id, job_id, next_job_id);
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
    const endpoint = toolEndpoints[target];
    const refusal =
      keyRefusal(current, endpoint === undefined ? "account" : endpointPermissions[endpoint]) ??
      (endpoint !== undefined && modelEndpoints.has(endpoint) ? modelRefusal(current) : undefined);
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
