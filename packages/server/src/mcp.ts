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
  SourceIdParams,
  Proposal,
  ProposalPage,
  ProposalCreate,
  ProposalUpdate,
  ProposalListQuery,
  UserSuggestion,
  UserSuggestionResult,
  Uuid,
} from "@great-minds/domain";
import { Context, Effect, Layer, Schema } from "effect";
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
import { ProposalsService } from "./proposals.ts";
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

const HttpEndpoint = Context.Reference<EndpointName | undefined>("@great-minds/mcp/HttpEndpoint", {
  defaultValue: () => undefined,
});

type ToolError = { readonly detail: string } | { readonly message: string };
const failed = (error: ToolError) =>
  new ToolFailed({ message: "detail" in error ? error.detail : error.message });
const asUser = <A, E extends ToolError, R>(run: (user: Uuid) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(CurrentAuth, (current) => run(current.user_id)).pipe(Effect.mapError(failed));

const tool = <
  const Name extends string,
  Params extends Schema.Constraint,
  Result extends Schema.Constraint,
>(
  name: Name,
  endpoint: EndpointName,
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
    .annotate(HttpEndpoint, endpoint)
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

const GreatMindsTools = Toolkit.make(
  tool("list_vaults", "listVaults", {
    description: "List the vaults this key can reach. Vault tools take one of their ids.",
    parameters: Schema.Struct(pageFields),
    success: VaultPage,
    readOnly: true,
  }),
  tool("search_vault", "searchVault", {
    description:
      "Search a vault's sources and wiki articles for passages about a subject. Returns the best-matching passages with their document path; read a whole document with read_document.",
    parameters: Schema.Struct({
      vault_id: vaultId,
      query: SearchQuery.fields.q,
      path: SearchQuery.fields.path.annotate({ description: "Only search inside this document" }),
    }),
    success: Schema.Struct({ hits: Schema.Array(SearchHit) }),
    readOnly: true,
  }),
  tool("read_document", "resolveDocument", {
    description:
      "Read a whole article (wiki/<slug>.md) or source (raw/...md) by its path. Articles cite their sources as markdown links and footnotes.",
    parameters: Schema.Struct({ vault_id: vaultId, path: Schema.String }),
    success: DocResponse,
    readOnly: true,
  }),
  tool("read_chunks", "readChunks", {
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
  }),
  tool("read_links", "readLinks", {
    description: "Read a wiki article's outgoing, incoming and related articles.",
    parameters: Schema.Struct({ vault_id: vaultId, ...LinkQuery.fields }),
    success: LinkedArticles,
    readOnly: true,
  }),
  tool("list_articles", "listWikiArticles", {
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
  }),
  tool("query_sources", "querySources", {
    description:
      "Filter a vault's sources by metadata: tags, author, genre, published date range, and the vault's own metadata fields. Returns a page of sources with their metadata and the total that match; page with offset. For questions about content, use search_vault instead.",
    parameters: Schema.Struct({ vault_id: vaultId, ...SourceQuery.fields }),
    success: SourceQueryPage,
    readOnly: true,
  }),
  tool("list_sessions", "listSessions", {
    description: "List a vault's question-and-answer sessions, newest first.",
    parameters: Schema.Struct({ vault_id: vaultId, ...pageFields }),
    success: SessionPage,
    readOnly: true,
  }),
  tool("read_session", "readSession", {
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
  }),
  tool("list_jobs", "listJobs", {
    description:
      "List Updates and uploads, newest first. Filter by status, including active; page with limit and offset.",
    parameters: Schema.Struct({ vault_id: vaultId, ...JobListQuery.fields, ...pageFields }),
    success: JobPage,
    readOnly: true,
  }),
  tool("read_job", "getJob", {
    description:
      "Read an Update or upload's status, stages, warnings and error. Does not wait for completion.",
    parameters: Schema.Struct({ vault_id: vaultId, job_id: Uuid }),
    success: JobResponse,
    readOnly: true,
  }),
  tool("start_update", "requestCompile", {
    description:
      "Start a paid Update of the vault. Owner only. Returns the accepted job immediately; use read_job to monitor it. This starts new work, not a retry of an old job.",
    parameters: Schema.Struct({ vault_id: vaultId }),
    success: JobResponse,
  }),
  tool("cancel_job", "cancelCompile", {
    description:
      "Request cancellation of an Update or upload. Owner only. Completed or missing jobs are unchanged; read_job confirms the current state.",
    parameters: Schema.Struct({ vault_id: vaultId, job_id: Uuid }),
    success: Schema.Struct({ job_id: Uuid }),
  }),
  tool("retry_url_job", "retryUrlJob", {
    description:
      "Retry a failed or cancelled URL import. Owner only; uses paid models. next_job_id must be a fresh UUID; reuse it when repeating this same retry request. Returns the accepted job immediately. Not for file uploads or manual Updates.",
    parameters: Schema.Struct({
      vault_id: vaultId,
      job_id: Uuid,
      next_job_id: CompileRequest.fields.job_id,
    }),
    success: JobResponse,
    openWorld: true,
  }),
  tool("ingest_url", "startUrlJob", {
    description:
      "Import a public URL into a vault and queue an Update. Owner only; uses paid models. Supply a new job_id UUID and reuse it for the same request after a lost response. Returns the accepted job immediately.",
    parameters: Schema.Struct({ vault_id: vaultId, ...URLSource.fields }),
    success: JobResponse,
    openWorld: true,
  }),
  tool("ingest_text", "ingestRaw", {
    description:
      "Import Markdown directly into a vault and queue an Update. Owner only; requires sponsorship. dest is a raw/ path ending .md; the server appends a UUID. Each call creates a new source: do not blindly retry an uncertain response.",
    parameters: Schema.Struct({ vault_id: vaultId, ...RawSource.fields }),
    success: IngestedDocument,
  }),
  tool("list_references", "listReferences", {
    description:
      "List your personal Reading Room references, not vault sources. Page with limit and offset.",
    parameters: Schema.Struct(pageFields),
    success: ReferencePage,
    readOnly: true,
  }),
  tool("read_reference", "resolveReference", {
    description: "Read one of your personal references by its refs/ path.",
    parameters: ReferencePromote,
    success: ReferenceDocumentResponse,
    readOnly: true,
  }),
  tool("save_reference", "createReference", {
    description:
      "Save a public URL in your personal Reading Room. Reuses an already saved URL. Does not add it to a vault or run an Update.",
    parameters: ReferenceCreate,
    success: ReferenceDetail,
    openWorld: true,
  }),
  tool("rename_reference", "updateReference", {
    description:
      "Change a personal reference's title; null clears the title. Does not change its text.",
    parameters: Schema.Struct({ ...ReferenceIdParams.fields, ...ReferenceUpdate.fields }),
    success: ReferenceDetail,
  }),
  tool("delete_reference", "deleteReference", {
    description:
      "Delete one of your personal references. There is no undo. Previously promoted vault sources are separate copies and remain.",
    parameters: ReferenceIdParams,
    success: ReferenceIdParams,
  }),
  tool("promote_reference", "promoteReference", {
    description:
      "Add a personal reference to a vault and queue an Update. Owner only; requires sponsorship. Reuses an existing promoted copy rather than adding it twice.",
    parameters: Schema.Struct({ vault_id: vaultId, ...ReferencePromote.fields }),
    success: IngestedDocument,
  }),
  tool("read_source", "readSource", {
    description: "Read a vault source by its stable id, including its body and metadata.",
    parameters: SourceIdParams,
    success: DocResponse,
    readOnly: true,
  }),
  tool("delete_source", "deleteSource", {
    description:
      "Permanently delete a source from a vault (owner only). Does not run an Update or remove generated articles. There is no undo.",
    parameters: SourceIdParams,
    success: Schema.Struct({ source_id: Uuid }),
  }),
  tool("request_source_deletion", "requestSourceDeletion", {
    description:
      "Ask the owner to delete a vault source. Editors only; owners use delete_source. Returns the pending proposal.",
    parameters: SourceIdParams,
    success: Proposal,
  }),
  tool("list_proposals", "listProposals", {
    description: "List vault source proposals with optional status and pagination.",
    parameters: Schema.Struct({
      vault_id: vaultId,
      ...pageFields,
      status: ProposalListQuery.fields.status,
    }),
    success: ProposalPage,
    readOnly: true,
  }),
  tool("read_proposal", "getProposal", {
    description: "Read a proposal's metadata, decision and application status.",
    parameters: Schema.Struct({ vault_id: vaultId, proposal_id: Uuid }),
    success: Proposal,
    readOnly: true,
  }),
  tool("create_proposal", "createProposal", {
    description:
      "Propose Markdown source content for an owner to review. Does not immediately publish the source. Each call creates a new proposal; do not retry blindly.",
    parameters: Schema.Struct({ vault_id: vaultId, ...ProposalCreate.fields }),
    success: Proposal,
  }),
  tool("review_proposal", "reviewProposal", {
    description:
      "Approve or reject a source proposal (owner only). Repeating the same decision is safe; changing it conflicts. Approval can still be applying; inspect application before claiming completion.",
    parameters: Schema.Struct({ vault_id: vaultId, proposal_id: Uuid, ...ProposalUpdate.fields }),
    success: Proposal,
  }),
  tool("submit_suggestion", "ingestUserSuggestion", {
    description:
      "Submit a correction or note, optionally anchored to a document and passage. Owners add it directly; editors submit a proposal. Each call creates new content; do not retry blindly.",
    parameters: Schema.Struct({ vault_id: vaultId, ...UserSuggestion.fields }),
    success: UserSuggestionResult,
  }),
  tool("ask", "createReply", {
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
  }),
);

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
    const proposals = yield* ProposalsService;

    return GreatMindsTools.of({
      list_vaults: (query) => asUser((user) => vaults.listVaults(user, page(query))),
      search_vault: ({ vault_id, query, path }) =>
        asUser((user) =>
          Effect.gen(function* () {
            yield* access.requireMember(user, vault_id);
            return { hits: yield* queries.search(user, vault_id, query, path) };
          }),
        ),
      read_document: ({ vault_id, path }) =>
        asUser((user) => documents.readDocument(user, vault_id, path)),
      read_chunks: ({ vault_id, ...query }) =>
        asUser((user) =>
          documents.readChunks(user, vault_id, query).pipe(Effect.map((chunks) => ({ chunks }))),
        ),
      read_links: ({ vault_id, ...query }) =>
        asUser((user) => documents.readLinks(user, vault_id, query)),
      list_articles: ({ vault_id, sort, ...query }) =>
        asUser((user) =>
          sort === "recent"
            ? wiki.listRecent(user, vault_id, page(query))
            : wiki.listArticles(user, vault_id, {
                ...query,
                ...page(query),
                sort: sort ?? "title",
              }),
        ),
      query_sources: ({ vault_id, ...query }) =>
        asUser((user) => sources.querySources(user, vault_id, query)),
      list_sessions: ({ vault_id, ...query }) =>
        asUser((user) => sessions.listSessions(user, vault_id, page(query))),
      read_session: ({ vault_id, session_id, format = "json", paper = "a4", ...selection }) =>
        asUser((user) =>
          Effect.gen(function* () {
            if (format === "json") return yield* sessions.readSession(user, vault_id, session_id);
            if (format === "pdf")
              return yield* exports.prepare(user, vault_id, session_id, { ...selection, paper });
            return { markdown: yield* exports.readMarkdown(user, vault_id, session_id, selection) };
          }),
        ).pipe(Effect.map((data) => ({ data }))),
      list_jobs: ({ vault_id, ...query }) =>
        asUser((user) => jobs.list(user, vault_id, { ...query, ...page(query) })),
      read_job: ({ vault_id, job_id }) => asUser((user) => jobs.get(user, vault_id, job_id)),
      start_update: ({ vault_id }) =>
        asUser((user) => jobs.requestCompile(user, vault_id, newUuid())),
      cancel_job: ({ vault_id, job_id }) =>
        asUser((user) => jobs.cancelCompile(user, vault_id, job_id).pipe(Effect.as({ job_id }))),
      retry_url_job: ({ vault_id, job_id, next_job_id }) =>
        asUser((user) => urlIngest.retry(user, vault_id, job_id, next_job_id)),
      ingest_url: ({ vault_id, job_id, url, ...input }) =>
        asUser((user) =>
          Effect.gen(function* () {
            return yield* urlIngest.start(user, vault_id, {
              ...input,
              jobId: job_id,
              url: yield* parseCanonicalSourceUrl(url),
            });
          }),
        ),
      ingest_text: ({ vault_id, ...input }) =>
        asUser((user) => ingest.ingestRaw(user, vault_id, input)),
      list_references: (query) => asUser((user) => references.list(user, page(query))),
      read_reference: ({ path }) => asUser((user) => references.read(user, path)),
      save_reference: ({ url }) =>
        asUser((user) =>
          Effect.gen(function* () {
            return (yield* references.create(user, yield* parseCanonicalSourceUrl(url))).reference;
          }),
        ),
      rename_reference: ({ reference_id, ...input }) =>
        asUser((user) => references.update(user, reference_id, input)),
      delete_reference: ({ reference_id }) =>
        asUser((user) => references.delete(user, reference_id).pipe(Effect.as({ reference_id }))),
      promote_reference: ({ vault_id, ...input }) =>
        asUser((user) =>
          ingest
            .promoteReference(user, vault_id, input)
            .pipe(Effect.map((result) => result.document)),
        ),
      read_source: ({ vault_id, source_id }) =>
        asUser((user) => documents.readSource(user, vault_id, source_id)),
      delete_source: ({ vault_id, source_id }) =>
        asUser((user) =>
          sources.deleteSource(user, vault_id, source_id).pipe(Effect.as({ source_id })),
        ),
      request_source_deletion: ({ vault_id, source_id }) =>
        asUser((user) => sources.requestSourceDeletion(user, vault_id, source_id)),
      list_proposals: ({ vault_id, ...query }) =>
        asUser((user) => proposals.list(user, vault_id, { ...query, ...page(query) })),
      read_proposal: ({ vault_id, proposal_id }) =>
        asUser((user) => proposals.get(user, vault_id, proposal_id)),
      create_proposal: ({ vault_id, ...input }) =>
        asUser((user) => proposals.create(user, vault_id, input)),
      review_proposal: ({ vault_id, proposal_id, ...input }) =>
        asUser((user) => proposals.review(user, vault_id, proposal_id, input)),
      submit_suggestion: ({ vault_id, ...input }) =>
        asUser((user) => ingest.ingestUserSuggestion(user, vault_id, input)),
      ask: ({ vault_id, question, session_id }) =>
        asUser((user) =>
          Effect.gen(function* () {
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
          }),
        ),
    });
  }),
);

const registeredTools: Readonly<Record<string, Tool.Any>> = GreatMindsTools.tools;
const KeyPermissions = McpServer.middleware((effect, { target }) =>
  Effect.gen(function* () {
    const current = yield* CurrentAuth;
    const selected = Object.hasOwn(registeredTools, target) ? registeredTools[target] : undefined;
    const endpoint =
      selected === undefined ? undefined : Context.get(selected.annotations, HttpEndpoint);
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
