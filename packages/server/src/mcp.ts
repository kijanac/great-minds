import { randomUUID } from "node:crypto";

import {
  Citation,
  Chunk,
  ChunkRangeQuery,
  CurrentAuth,
  DocResponse,
  IngestedDocument,
  RawSource,
  URLSource,
  ReferenceCreate,
  ReferenceDetail,
  ReferenceDocumentResponse,
  ReferencePage,
  ReferencePromote,
  ReferenceUpdate,
  ReferenceIdParams,
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
import { IngestService } from "./ingest.ts";
import { UserDocumentsService } from "./user-documents.ts";
import { parseCanonicalSourceUrl } from "./source-identity.ts";
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

const tool = <
  const Name extends string,
  Params extends Schema.Constraint,
  Result extends Schema.Constraint,
>(
  name: Name,
  {
    readOnly = false,
    openWorld = false,
    ...options
  }: {
    readonly description: string;
    readonly parameters: Params;
    readonly success: Result;
    readonly readOnly?: boolean;
    readonly openWorld?: boolean;
  },
) =>
  Tool.make(name, { ...options, failure: ToolFailed, dependencies: [CurrentAuth] })
    .annotate(Tool.Readonly, readOnly)
    .annotate(Tool.OpenWorld, openWorld);

const vaultId = Uuid.annotate({ description: "Vault id, from list_vaults" });
const pageFields = {
  limit: Schema.optionalKey(Schema.toType(PageParamsQuery.fields.limit)),
  offset: Schema.optionalKey(Schema.toType(PageParamsQuery.fields.offset)),
};
const page = (query: { readonly limit?: number; readonly offset?: number }) => ({
  limit: query.limit ?? 50,
  offset: query.offset ?? 0,
});

const ListVaults = tool("list_vaults", {
  description: "List the vaults this key can reach. Vault tools take one of their ids.",
  parameters: Schema.Struct(pageFields),
  success: VaultPage,
  readOnly: true,
});

const SearchVault = tool("search_vault", {
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
  readOnly: true,
});

const ReadDocument = tool("read_document", {
  description:
    "Read a whole article (wiki/<slug>.md) or source (raw/...md) by its path. Articles cite their sources as markdown links and footnotes.",
  parameters: Schema.Struct({ vault_id: vaultId, path: Schema.String }),
  success: DocResponse,
  readOnly: true,
});

const ReadChunks = tool("read_chunks", {
  description:
    "Read an inclusive range of indexed document chunks, up to 100. Use the chunk_index returned by search_vault. Negative starts clamp to zero.",
  parameters: Schema.Struct({
    vault_id: vaultId,
    path: ChunkRangeQuery.fields.path,
    start: Schema.toType(ChunkRangeQuery.fields.start),
    end: Schema.toType(ChunkRangeQuery.fields.end),
  }),
  success: Schema.Struct({ chunks: Schema.Array(Chunk) }),
  readOnly: true,
});

const ReadLinks = tool("read_links", {
  description: "Read a wiki article's outgoing, incoming and related articles.",
  parameters: Schema.Struct({ vault_id: vaultId, ...LinkQuery.fields }),
  success: LinkedArticles,
  readOnly: true,
});

const ListArticles = tool("list_articles", {
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
  readOnly: true,
});

const QuerySources = tool("query_sources", {
  description:
    "Filter a vault's sources by metadata: tags, author, genre, published date range, and the vault's own metadata fields. Returns a page of sources with their metadata and the total that match; page with offset. For questions about content, use search_vault instead.",
  parameters: Schema.Struct({ vault_id: vaultId, ...SourceQuery.fields }),
  success: SourceQueryPage,
  readOnly: true,
});

const ListSessions = tool("list_sessions", {
  description: "List a vault's question-and-answer sessions, newest first.",
  parameters: Schema.Struct({ vault_id: vaultId, ...pageFields }),
  success: SessionPage,
  readOnly: true,
});

const ReadSession = tool("read_session", {
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
  readOnly: true,
});

const ListJobs = tool("list_jobs", {
  description:
    "List Updates and uploads, newest first. Filter by status, including active; page with limit and offset.",
  parameters: Schema.Struct({ vault_id: vaultId, ...JobListQuery.fields, ...pageFields }),
  success: JobPage,
  readOnly: true,
});

const ReadJob = tool("read_job", {
  description:
    "Read an Update or upload's status, stages, warnings and error. Does not wait for completion.",
  parameters: Schema.Struct({ vault_id: vaultId, job_id: Uuid }),
  success: JobResponse,
  readOnly: true,
});

const StartUpdate = tool("start_update", {
  description:
    "Start a paid Update of the vault. Owner only. Returns the accepted job immediately; use read_job to monitor it. This starts new work, not a retry of an old job.",
  parameters: Schema.Struct({ vault_id: vaultId }),
  success: JobResponse,
});

const CancelJob = tool("cancel_job", {
  description:
    "Request cancellation of an Update or upload. Owner only. Completed or missing jobs are unchanged; read_job confirms the current state.",
  parameters: Schema.Struct({ vault_id: vaultId, job_id: Uuid }),
  success: Schema.Struct({ job_id: Uuid }),
});

const RetryUrlJob = tool("retry_url_job", {
  description:
    "Retry a failed or cancelled URL import. Owner only; uses paid models. next_job_id must be a fresh UUID; reuse it when repeating this same retry request. Returns the accepted job immediately. Not for file uploads or manual Updates.",
  parameters: Schema.Struct({
    vault_id: vaultId,
    job_id: Uuid,
    next_job_id: CompileRequest.fields.job_id,
  }),
  success: JobResponse,
  openWorld: true,
});

const IngestUrl = tool("ingest_url", {
  description:
    "Import a public URL into a vault and queue an Update. Owner only; uses paid models. Supply a new job_id UUID and reuse it for the same request after a lost response. Returns the accepted job immediately.",
  parameters: Schema.Struct({ vault_id: vaultId, ...URLSource.fields }),
  success: JobResponse,
  openWorld: true,
});

const IngestText = tool("ingest_text", {
  description:
    "Import Markdown directly into a vault and queue an Update. Owner only; requires sponsorship. dest is a raw/ path ending .md; the server appends a UUID. Each call creates a new source: do not blindly retry an uncertain response.",
  parameters: Schema.Struct({ vault_id: vaultId, ...RawSource.fields }),
  success: IngestedDocument,
});

const ListReferences = tool("list_references", {
  description:
    "List your personal Reading Room references, not vault sources. Page with limit and offset.",
  parameters: Schema.Struct(pageFields),
  success: ReferencePage,
  readOnly: true,
});

const ReadReference = tool("read_reference", {
  description: "Read one of your personal references by its refs/ path.",
  parameters: ReferencePromote,
  success: ReferenceDocumentResponse,
  readOnly: true,
});

const SaveReference = tool("save_reference", {
  description:
    "Save a public URL in your personal Reading Room. Reuses an already saved URL. Does not add it to a vault or run an Update.",
  parameters: ReferenceCreate,
  success: ReferenceDetail,
  openWorld: true,
});

const RenameReference = tool("rename_reference", {
  description:
    "Change a personal reference's title; null clears the title. Does not change its text.",
  parameters: Schema.Struct({ ...ReferenceIdParams.fields, ...ReferenceUpdate.fields }),
  success: ReferenceDetail,
});

const DeleteReference = tool("delete_reference", {
  description:
    "Delete one of your personal references. There is no undo. Previously promoted vault sources are separate copies and remain.",
  parameters: ReferenceIdParams,
  success: ReferenceIdParams,
});

const PromoteReference = tool("promote_reference", {
  description:
    "Add a personal reference to a vault and queue an Update. Owner only; requires sponsorship. Reuses an existing promoted copy rather than adding it twice.",
  parameters: Schema.Struct({ vault_id: vaultId, ...ReferencePromote.fields }),
  success: IngestedDocument,
});

const Ask = tool("ask", {
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
});

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
  IngestUrl,
  IngestText,
  ListReferences,
  ReadReference,
  SaveReference,
  RenameReference,
  DeleteReference,
  PromoteReference,
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
  ingest_url: "startUrlJob",
  ingest_text: "ingestRaw",
  list_references: "listReferences",
  read_reference: "resolveReference",
  save_reference: "createReference",
  rename_reference: "updateReference",
  delete_reference: "deleteReference",
  promote_reference: "promoteReference",
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
    const ingest = yield* IngestService;
    const references = yield* UserDocumentsService;
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
      ingest_url: ({ vault_id, job_id, url, ...input }) =>
        Effect.gen(function* () {
          return yield* urlIngest.start(yield* userId, vault_id, {
            ...input,
            jobId: job_id,
            url: yield* parseCanonicalSourceUrl(url),
          });
        }).pipe(Effect.mapError(failed)),
      ingest_text: ({ vault_id, ...input }) =>
        Effect.gen(function* () {
          return yield* ingest.ingestRaw(yield* userId, vault_id, input);
        }).pipe(Effect.mapError(failed)),
      list_references: (query) =>
        Effect.gen(function* () {
          return yield* references.list(yield* userId, page(query));
        }),
      read_reference: ({ path }) =>
        Effect.gen(function* () {
          return yield* references.read(yield* userId, path);
        }).pipe(Effect.mapError(failed)),
      save_reference: ({ url }) =>
        Effect.gen(function* () {
          return (yield* references.create(yield* userId, yield* parseCanonicalSourceUrl(url)))
            .reference;
        }).pipe(Effect.mapError(failed)),
      rename_reference: ({ reference_id, ...input }) =>
        Effect.gen(function* () {
          return yield* references.update(yield* userId, reference_id, input);
        }).pipe(Effect.mapError(failed)),
      delete_reference: ({ reference_id }) =>
        Effect.gen(function* () {
          yield* references.delete(yield* userId, reference_id);
          return { reference_id };
        }).pipe(Effect.mapError(failed)),
      promote_reference: ({ vault_id, ...input }) =>
        Effect.gen(function* () {
          return (yield* ingest.promoteReference(yield* userId, vault_id, input)).document;
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
