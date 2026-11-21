import { randomUUID } from "node:crypto";

import {
  Database,
  llmCostEvents,
  searchIndex,
  sourceDocuments,
  wikiArticles,
} from "@great-minds/database";
import {
  BadRequest,
  FileFingerprint,
  ServiceUnavailable,
  type DraftHintResponse,
  type LinkedArticles,
  type SearchHit,
  SourceQuery,
  type OriginScope,
  type QueryMode,
  type QuerySourceArticle,
  type QuerySourceData,
  type QuerySourceSearch,
  QuerySourceData as QuerySourceDataSchema,
  Uuid,
} from "@great-minds/domain";
import { and, asc, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { Cause, Context, Data, Effect, Layer, Option, Schema, Stream } from "effect";

import { ClockService } from "./clock.ts";
import { AppConfig, missingModelKey, notConfiguredDetail } from "./config.ts";
import { existingUser } from "./cost-ledger.ts";
import { defaultVaultConfigFile, readVaultConfig, type VaultConfigFile } from "./vault-config.ts";
import { promptContentHash } from "./crypto.ts";
import {
  type EmbeddingBatchFailed,
  EmbeddingsService,
  searchQueryInput,
  vectorLiteral,
} from "./embeddings.ts";
import { CostLookupService, recordPrompt } from "./llm-costs.ts";
import {
  LanguageModel,
  LlmMessageSchema,
  LlmToolDefinitionSchema,
  ModelProviderError,
  type LlmMessage,
  type LlmToolDefinition,
  type RetryableModelError,
  stripJsonFence,
} from "./llm.ts";
import { StructuredLogger } from "./logging.ts";
import { ParallelSearchService, type ParallelSearchResult } from "./parallel.ts";
import { loadPrompt } from "./prompts.ts";
import { ContentStorage, userOwner, vaultOwner } from "./storage.ts";
import { readSourceSummary } from "./document-metadata.ts";
import { articleLinks, chunkRange } from "./documents.ts";
import { querySourceRows } from "./source-query.ts";
import { articleOrder, listArticlePage, listedArticleConditions } from "./wiki.ts";
import { liveArticleConditions } from "./wiki-articles.ts";
import { withFootnoteNotes } from "./wiki-footnotes.ts";

type QueryServiceShape = {
  readonly prepareExecution: (
    userId: Uuid,
    vaultId: Uuid,
    input: QueryInput,
    prior: readonly LlmMessage[],
  ) => Effect.Effect<QueryExecutionState>;
  readonly modelAttempt: (
    state: QueryExecutionState,
    onToken: (text: string) => Effect.Effect<void>,
  ) => Effect.Effect<QueryModelAttemptResult>;
  readonly runTool: (
    state: QueryExecutionState,
    toolCall: QueryPreparedToolCall,
  ) => Effect.Effect<QuerySourceData | undefined, EmbeddingBatchFailed>;
  readonly finalizeExecution: (state: QueryExecutionState) => Effect.Effect<void>;
  readonly draftHint: (
    userId: Uuid,
    description: string,
  ) => Effect.Effect<DraftHintResponse, BadRequest | ServiceUnavailable>;
  readonly search: (
    userId: Uuid,
    vaultId: Uuid,
    query: string,
    path: string | undefined,
  ) => Effect.Effect<readonly SearchHit[], EmbeddingBatchFailed>;
};

export class QueryService extends Context.Service<QueryService, QueryServiceShape>()(
  "@great-minds/server/QueryService",
) {}

type ToolCallState = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
};

const QueryTraceSchema = Schema.Struct({
  articlesRead: Schema.mutableKey(Schema.Number),
  sourcesRead: Schema.mutableKey(Schema.Number),
  searches: Schema.mutableKey(Schema.Number),
  llmRounds: Schema.mutableKey(Schema.Number),
  toolCalls: Schema.mutableKey(Schema.Number),
});

export const QueryExecutionState = Schema.Struct({
  userId: Uuid,
  vaultId: Uuid,
  question: Schema.String,
  typedQuestion: Schema.String,
  vaultLabel: Schema.String,
  mode: Schema.Literals(["query", "btw"] as const),
  correlationId: Schema.String,
  tools: Schema.Array(LlmToolDefinitionSchema),
  messages: Schema.mutable(Schema.Array(LlmMessageSchema)),
  turnStart: Schema.Number,
  webSearchEnabled: Schema.Boolean,
  trace: QueryTraceSchema,
  fallbackGenerationIds: Schema.mutable(Schema.Array(Schema.String)),
  systemPromptHash: FileFingerprint,
  costUsd: Schema.mutableKey(Schema.Number),
  selectedModel: Schema.mutableKey(Schema.NullOr(Schema.String)),
  models: Schema.NonEmptyArray(Schema.NonEmptyString),
  modelIndex: Schema.mutableKey(Schema.Number),
  startedAt: Schema.Number,
});
export type QueryExecutionState = typeof QueryExecutionState.Type;

export const QueryPreparedToolCall = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
  pendingSource: Schema.optionalKey(QuerySourceDataSchema),
});
export type QueryPreparedToolCall = typeof QueryPreparedToolCall.Type;

const ToolInteger = Schema.Union([Schema.Int, Schema.NumberFromString]).pipe(
  Schema.decodeTo(Schema.Int),
);

const tools = {
  read_document: {
    description:
      "Use to read a document you already have the `path` for. A small document is returned in full; a LARGE document returns only a section OUTLINE, not its text. If you have a query and the document is large, do NOT use this to read it — use search_in_document(path, query) to jump to the relevant passages. Read an outlined section with expand_context(path, start, end).",
    args: Schema.Struct({
      path: Schema.NonEmptyString.annotate({
        description:
          "Document path, e.g. wiki/capitalism.md or raw/texts/lenin/works/1893/market/02.md",
      }),
    }),
  },
  expand_context: {
    description:
      "Use to fetch a specific `start`-`end` chunk range you ALREADY obtained from a search hit or a read_document outline. Do NOT use it to explore a document — guessing a range (e.g. chunks 1-10) wastes turns; run search_in_document(path, query) first and expand only the chunks it returns.",
    args: Schema.Struct({
      path: Schema.NonEmptyString.annotate({
        description:
          "Document path from a search result or outline, e.g. raw/texts/lenin/works/1916/imperialism/03.md",
      }),
      start: ToolInteger.annotate({ description: "First chunk index to read (inclusive)" }),
      end: ToolInteger.annotate({ description: "Last chunk index to read (inclusive)" }),
    }),
  },
  linked_articles: {
    description:
      "Use when you have a wiki article `path` and want its neighbors in the citation graph — outgoing and incoming links — to follow related articles without reading their bodies. Returns linked titles + paths only. Do NOT use it to find passages or do topical search (use search_content / search_in_document). Pass a wiki article path, e.g. wiki/imperialism.md.",
    args: Schema.Struct({
      path: Schema.NonEmptyString.annotate({
        description:
          "Wiki article path, e.g. wiki/imperialism.md (from a search hit or another article's links)",
      }),
    }),
  },
  search_content: {
    description:
      "Use FIRST only when you don't yet know which document holds the answer — hybrid search across the WHOLE knowledge base (all raw sources + all wiki articles), matching title, precis, author, and body text. Returns ranked excerpts each with a `path` and `chunk_index`. Once you have a specific path, do NOT search here again — use search_in_document to search inside it, or read_document to read it.",
    args: Schema.Struct({
      query: Schema.NonEmptyString.annotate({ description: "Search term or phrase" }),
    }),
  },
  list_articles: {
    description:
      "Use to BROWSE the wiki article index — the synthesized encyclopedia — by title and path, most-linked first (sort=central). Reach for it FIRST to orient on a concept, person, work, or '-ism', or to find a known article's real path before reading it. Returns titles + paths only, no body text. `contains` is a literal title/precis substring filter — for topical or fuzzy discovery use search_content instead.",
    args: Schema.Struct({
      contains: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "Literal substring to match in an article's title/precis (not semantic — use search_content for meaning-based discovery)",
        }),
      ),
      sort: Schema.optionalKey(
        Schema.Literals(["central", "recent", "alpha"]).annotate({
          description:
            "central = most-linked first (best for orientation), recent = newest first, alpha = A–Z. Default central.",
        }),
      ),
      page: Schema.optionalKey(
        ToolInteger.annotate({ description: "1-based page number (default 1)" }),
      ),
    }),
  },
  search_in_document: {
    description:
      "Use when you HAVE a document `path` and want the passages of THAT document relevant to a query — hybrid search scoped to one document. ALWAYS prefer this over read_document + expand_context for any document large enough to return an outline: it finds the relevant chunks instead of making you guess a range. Returns matching chunks with indexes for expand_context(path, start, end).",
    args: Schema.Struct({
      path: Schema.NonEmptyString.annotate({
        description:
          "Document path to search within, e.g. raw/texts/lenin/works/1916/imperialism/03.md",
      }),
      query: Schema.NonEmptyString.annotate({ description: "Search term or phrase" }),
    }),
  },
  query_documents: {
    description:
      "Use when the question names a STRUCTURED attribute of raw sources — a tag, author, genre, date/date-range, or one of this vault's own metadata fields (e.g. 'sources by X', 'everything tagged Y', 'written after Z'). Filters by metadata, not text content. Results report the total that match; page through them with offset. Do NOT use it for topical/conceptual questions (use search_content), and do NOT use it for wiki articles (use list_articles). ",
    args: Schema.Struct({
      ...SourceQuery.fields,
      limit: Schema.optionalKey(
        Schema.Int.annotate({ description: "Results per call (default 20, at most 50)" }),
      ),
      offset: Schema.optionalKey(
        Schema.Int.annotate({ description: "Skip this many results, to page through a total" }),
      ),
    }),
  },
  web_search: {
    description:
      "Search the open web for facts the knowledge base does not contain — recent events, dates, figures, names. Use ONLY after the knowledge base has come up empty on a factual point; the knowledge base remains the source for analysis and interpretation. Results are EXTERNAL: cite them as [title](url) and make clear they are from the web, not the knowledge base.",
    args: Schema.Struct({
      query: Schema.NonEmptyString.annotate({ description: "Web search query" }),
    }),
  },
};

const QueryTool = Schema.Union([
  Schema.Struct({ name: Schema.Literal("read_document"), args: tools.read_document.args }),
  Schema.Struct({ name: Schema.Literal("expand_context"), args: tools.expand_context.args }),
  Schema.Struct({ name: Schema.Literal("linked_articles"), args: tools.linked_articles.args }),
  Schema.Struct({ name: Schema.Literal("search_content"), args: tools.search_content.args }),
  Schema.Struct({ name: Schema.Literal("list_articles"), args: tools.list_articles.args }),
  Schema.Struct({
    name: Schema.Literal("search_in_document"),
    args: tools.search_in_document.args,
  }),
  Schema.Struct({ name: Schema.Literal("web_search"), args: tools.web_search.args }),
  Schema.Struct({ name: Schema.Literal("query_documents"), args: tools.query_documents.args }),
]);
type QueryTool = typeof QueryTool.Type;
const decodeQueryTool = Schema.decodeUnknownEffect(QueryTool);
const jsonArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

type QueryModelAttemptResult =
  | { readonly kind: "retryable" }
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "tool_calls"; readonly toolCalls: readonly QueryPreparedToolCall[] };

type ModelRoundState = {
  content: string;
  reasoning: string;
  finishReason: string | null;
  readonly toolCalls: Map<number, ToolCallState>;
};

export type QueryInput = {
  readonly question: string;
  readonly typedQuestion: string;
  readonly mode: QueryMode;
  readonly vaultLabel: string;
  readonly originPath: string | undefined;
  readonly originScope: OriginScope;
};

type ToolResult = {
  readonly content: string;
  readonly source?: QuerySourceData;
};

type SourceDetail = Pick<QuerySourceArticle, "full" | "outline" | "chunks"> &
  Pick<QuerySourceSearch, "results" | "hits">;

class ToolMiss extends Data.TaggedError("ToolMiss")<{
  readonly message: string;
}> {}

export const sanitizedStreamError = "Something went wrong while answering. Try again in a minute.";
export const truncatedAnswerError =
  "The answer was cut off at the model's length limit. Try again, or ask a narrower question.";

export const searchWords = (query: string) =>
  query
    .replace(/[^\p{L}\p{N}_\s]/gu, "")
    .split(/\s+/)
    .filter((word) => word.length > 2);

const parseTool = (toolCall: { readonly name: string; readonly arguments: string }) =>
  Option.match(jsonArguments(toolCall.arguments), {
    onNone: () =>
      Effect.fail(
        new ToolMiss({
          message: `The arguments for ${toolCall.name} were not a JSON object. Call it again with valid JSON arguments.`,
        }),
      ),
    onSome: (args) =>
      decodeQueryTool({ name: toolCall.name, args }).pipe(
        Effect.mapError((error) => new ToolMiss({ message: error.message })),
      ),
  });
const readWholeLimit = 20_000;
const maxRangeChunks = 40;
const articlesPerPage = 25;
const rrfK = 60;
const maxSearchResults = 20;
const maxSourceHits = 8;
const searchArmMultiplier = 2;

const fetchRange = (rawStart: number, rawEnd: number) => {
  const start = Math.max(0, Math.min(rawStart, rawEnd));
  return { start, end: Math.min(Math.max(rawStart, rawEnd, start), start + maxRangeChunks - 1) };
};

const first = <A>(values: readonly A[]) => values[0];

const logErrorFields = (error: unknown) => {
  if (error instanceof Error) {
    return {
      error_type: error.name,
      error_message: error.message,
      stack: error.stack,
    };
  }
  return {
    error_type: typeof error,
    error_message: String(error),
    stack: undefined,
  };
};

export const retrievalCore = `You answer questions over a knowledge base by researching its documents with tools, then writing a cited answer. Work in four stages — each stage tells you which tool to reach for. Don't jump straight to whole-base search.

STAGE 1 — ORIENT. Get the lay of the land before hunting for passages.
- list_articles(contains, sort=central|recent|alpha): browse the rendered wiki articles — a synthesized encyclopedia, most-linked first. For any question about a concept, person, work, or term, START here to find the canonical article and its real path instead of guessing one.
- query_documents(tags, author, genre, date): when the question names a structured attribute of raw sources (an author, tag, genre, or date range), filter by it. Do NOT approximate a metadata filter with search_content.
If orientation finds nothing on the subject, the base likely doesn't cover it — see GROUNDING.

STAGE 2 — LOCATE. Find the passages that answer the question.
- search_content(query): hybrid search across the WHOLE base (raw + wiki). Your default only when you do not yet know which document to look in.
- search_in_document(path, query): hybrid search scoped to ONE document. The moment you know which document matters (from Stage 1, a citation, or a search hit), use this to jump to the relevant passages. ALWAYS prefer it over reading a long document from the top.
- linked_articles(path): a wiki article's outgoing/incoming citation links — follow the base's own connections to related articles and sources.

STAGE 3 — READ. Pull the exact text you will cite. Use only paths returned by earlier stages — never a path typed from memory.
- read_document(path): read a document. A large document returns a heading OUTLINE, not its text. If read_document returns an outline, your NEXT call MUST be search_in_document(path, query) to locate the relevant section — do NOT expand_context from the start of the document.
- expand_context(path, start, end): expand_context NEVER comes first. It reads a chunk range you have ALREADY located via a search hit or a specific outline section. If you are about to call it without a prior locating call, stop and call search_in_document first.

STAGE 4 — VERIFY & ANSWER. Re-read the strongest passages, then write. Open with the answer itself — no preamble about your process. Cite the source behind each claim with an inline markdown link, anchored to the supporting chunk's index where you have one so the link opens the document at that passage. If sources are thin or conflict, say so.

GROUNDING (non-negotiable):
- Ground every substantive claim in the retrieved texts and cite them; do not rely on your general knowledge.
- If the base does not cover the subject, say so plainly. Any outside context must be labeled explicitly as outside the knowledge base and kept minimal.

AVOID THESE HABITS:
- Reading a long document from the top (outline, then the first chunks) instead of search_in_document(path, query).
- Guessing or typing a document path — only use paths a tool returned.
- Defaulting to whole-base search_content when you already know the target document — search_in_document is faster and more precise.
- Answering an uncovered subject from general knowledge without disclosing it.
- Stopping at the first hit — orient and follow links before concluding the base is silent.

Knowledge base:
{identity}`;

const lengthCues = {
  btw: "\n\n(Keep the answer brief: one or two short paragraphs.)",
  query: "\n\n(Match the length to what this question needs; when in doubt, be shorter.)",
} as const;

export const webSearchGuidance =
  "WEB SEARCH: Use web_search only for facts about reality the knowledge base lacks — what happened, when, who, how many. The analysis is always yours, drawn from this knowledge base's framework applied to those facts; never take your interpretation, lessons, or strategic conclusions from a web source — not even with attribution. You may report what an outside source claims only when the question is itself about those claims (e.g. \"how did different groups read this event\"); otherwise do not repeat or lean on another author's analysis. Exhaust the knowledge base first. Cite web facts as [title](url).";

export const webFactExtractionPrompt =
  "You extract FACTS from web search results for a research assistant whose analysis comes only from its own knowledge base, never from the web. You are given the user's question and a numbered list of web results. For each result, return the empirical facts it states — and only facts.\n\n" +
  "KEEP (facts): concrete events, dates, counts, named people and organizations, official acts and labels, and direct accounts of what someone concretely said or did. Preserve the source's own wording — do not soften, neutralize, or editorialize it. Extract only what the result actually states; never infer, generalize, or add.\n\n" +
  "DROP (analysis): the source's evaluation, interpretation, strategy, predictions, lessons, or conclusions. Anything about what an event MEANS or what SHOULD be done is not a fact.\n\n" +
  "DISCOURSE FACTS — statements of who-published-or-argued-what (e.g. 'Group X released a statement calling for Y', 'Outlet Z called the event a turning point'): include these ONLY when the user's question is about the discourse itself — how groups or sources framed, analyzed, or responded to the event. When the question asks you to analyze the event, omit them entirely.\n\n" +
  "If a result states no usable facts — pure commentary, or only discourse facts for a non-discourse question — return an empty list for it.\n\n" +
  'Return JSON of the form {"results": [{"index": <the result\'s number>, "facts": ["fact", ...]}]}. Include an entry for every result; use an empty facts list when there is nothing to extract.';

export const draftHintSystem =
  "You translate a user's free-form description of their knowledge base " +
  "into a one-paragraph editorial steer for an LLM that decides how to " +
  "frame canonical wiki topics. The steer should describe what kinds of " +
  "framings to prefer (e.g. event-centric vs biographical, debate-centric " +
  "vs descriptive) given the user's domain. Keep it 2–4 sentences, " +
  "concrete, and actionable. Do not include preamble, headings, or " +
  "quotation marks — return only the steer text.";

const toolDefinitions = (
  tags: readonly string[],
  fields: VaultConfigFile["enrichedFields"],
  webSearch: boolean,
): readonly LlmToolDefinition[] =>
  Object.entries(tools).flatMap(([name, tool]): LlmToolDefinition[] =>
    name === "web_search" && !webSearch
      ? []
      : [
          {
            type: "function",
            function: {
              name,
              description:
                name === "query_documents"
                  ? tool.description +
                    (tags.length > 0 ? `Available tags: ${tags.join(", ")}. ` : "No tags yet. ") +
                    (fields.length > 0
                      ? `This vault's own fields (filter with fields: {name: value}): ${fields
                          .map(
                            (field) =>
                              `${field.name} (${field.type}${field.description === "" ? "" : `: ${field.description}`})`,
                          )
                          .join("; ")}.`
                      : "This vault declares no metadata fields of its own.")
                  : tool.description,
              parameters: Schema.toJsonSchemaDocument(Schema.toType(tool.args)).schema,
            },
          },
        ],
  );

const truthyEntries = (args: Record<string, unknown>) =>
  Object.entries(args).filter(([, value]) => Boolean(value));

const pendingSourceEvent = (tool: QueryTool): QuerySourceData => {
  switch (tool.name) {
    case "read_document":
    case "expand_context": {
      const path = tool.args.path;
      const type = path.startsWith("wiki/") ? "article" : "raw";
      return tool.name === "expand_context"
        ? {
            type,
            document_id: null,
            path,
            title: null,
            ...fetchRange(tool.args.start, tool.args.end),
          }
        : { type, document_id: null, path, title: null };
    }
    case "search_content":
      return { type: "search", query: tool.args.query, scope: "kb", title: null };
    case "web_search":
      return { type: "search", query: tool.args.query, scope: "web", title: null };
    case "search_in_document":
      return {
        type: "search",
        query: tool.args.query,
        scope: "kb",
        path: tool.args.path,
        title: null,
      };
    case "query_documents":
      return { type: "query", filters: Object.fromEntries(truthyEntries(tool.args)) };
    case "list_articles":
      return {
        type: "query",
        filters: Object.fromEntries(
          truthyEntries({ contains: tool.args.contains, sort: tool.args.sort }),
        ),
      };
    case "linked_articles":
      return { type: "links", path: tool.args.path, title: null };
  }
};

const WebFactExtraction = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ index: Schema.Number, facts: Schema.Array(Schema.String) }),
  ),
});

export const QueryServiceLive = Layer.effect(
  QueryService,
  Effect.gen(function* () {
    const db = yield* Database;
    const storage = yield* ContentStorage;
    const logger = yield* StructuredLogger;
    const languageModel = yield* LanguageModel;
    const embeddings = yield* EmbeddingsService;
    const costs = yield* CostLookupService;
    const parallel = yield* ParallelSearchService;
    const appConfig = yield* AppConfig;
    const clock = yield* ClockService;

    const vaultConfig = (vaultId: Uuid) =>
      readVaultConfig(storage, vaultId).pipe(
        Effect.catchTag("VaultConfigMalformed", () => Effect.succeed(defaultVaultConfigFile)),
      );

    const documentForPath = (vaultId: Uuid, path: string) =>
      Effect.gen(function* () {
        if (path.startsWith("wiki/")) {
          const rows = yield* db.query((d) =>
            d
              .select({ id: wikiArticles.id, title: wikiArticles.title })
              .from(wikiArticles)
              .where(and(eq(wikiArticles.vaultId, vaultId), eq(wikiArticles.filePath, path)))
              .limit(1),
          );
          const row = first(rows);
          return { document_id: row?.id ?? null, title: row?.title ?? null };
        }
        const rows = yield* db.query((d) =>
          d
            .select({ id: sourceDocuments.id, title: sourceDocuments.title })
            .from(sourceDocuments)
            .where(and(eq(sourceDocuments.vaultId, vaultId), eq(sourceDocuments.filePath, path)))
            .limit(1),
        );
        const row = first(rows);
        return { document_id: row?.id ?? null, title: row?.title ?? null };
      });

    const buildIdentity = (vaultId: Uuid, label: string, vaultConfig: VaultConfigFile) =>
      Effect.gen(function* () {
        const [wikiCountRows, rawCountRows] = yield* Effect.all(
          [
            db.query((d) =>
              d
                .select({ count: sql<number>`count(*)::int` })
                .from(wikiArticles)
                .where(and(...liveArticleConditions(vaultId))),
            ),
            db.query((d) =>
              d
                .select({ count: sql<number>`count(*)::int` })
                .from(sourceDocuments)
                .where(eq(sourceDocuments.vaultId, vaultId)),
            ),
          ],
          { concurrency: "unbounded" },
        );
        const wikiCount = first(wikiCountRows)?.count ?? 0;
        const rawCount = first(rawCountRows)?.count ?? 0;
        const focus = vaultConfig.thematicHint.trim() || "(no editorial focus set)";
        return (
          `### ${label}\n` +
          `Focus: ${focus}\n` +
          `Coverage: ${wikiCount} wiki article${wikiCount === 1 ? "" : "s"}, ` +
          `${rawCount} raw source${rawCount === 1 ? "" : "s"}.`
        );
      });

    const distinctTags = (vaultId: Uuid) =>
      db
        .query((d) =>
          d
            .selectDistinct({ tag: sql<string>`unnest(${sourceDocuments.tags})`.as("tag") })
            .from(sourceDocuments)
            .where(eq(sourceDocuments.vaultId, vaultId))
            .orderBy(asc(sql`tag`)),
        )
        .pipe(Effect.map((rows) => rows.map((row) => row.tag).filter((tag) => tag.length > 0)));

    const buildSystemPrompt = (
      vaultId: Uuid,
      label: string,
      vaultConfig: VaultConfigFile,
      mode: QueryMode,
      webSearchEnabled: boolean,
    ) =>
      Effect.gen(function* () {
        const [identity, queryPrompt, btwPrompt] = yield* Effect.all(
          [
            buildIdentity(vaultId, label, vaultConfig),
            loadPrompt(storage, vaultId, "query"),
            mode === "btw" ? loadPrompt(storage, vaultId, "query_btw") : Effect.succeed(null),
          ],
          { concurrency: "unbounded" },
        );
        const today = (yield* clock.now).toISOString().slice(0, 10);
        let prompt = retrievalCore.replace("{identity}", identity);
        prompt += `\n\nToday's date is ${today} (UTC).`;
        prompt += "\n\n" + queryPrompt;
        if (webSearchEnabled) {
          prompt += "\n\n" + webSearchGuidance;
        }
        if (btwPrompt !== null) {
          prompt += "\n\n" + btwPrompt;
        }
        return prompt;
      });

    const sourceEvent = (
      context: QueryExecutionState,
      tool: QueryTool,
      detail: SourceDetail = {},
    ): Effect.Effect<QuerySourceData> =>
      Effect.gen(function* () {
        const source = pendingSourceEvent(tool);
        if (source.type === "article" || source.type === "raw") {
          return {
            ...source,
            ...(yield* documentForPath(context.vaultId, source.path)),
            ...(detail.full === true ? { full: true } : {}),
            ...(detail.outline === true ? { outline: true } : {}),
            ...(detail.chunks === undefined ? {} : { chunks: detail.chunks }),
          };
        }
        const results = detail.results === undefined ? {} : { results: detail.results };
        if (source.type === "query") return { ...source, ...results };
        const title =
          source.path === undefined
            ? {}
            : { title: (yield* documentForPath(context.vaultId, source.path)).title };
        if (source.type === "links") return { ...source, ...title, ...results };
        return {
          ...source,
          ...title,
          ...results,
          ...(detail.hits === undefined ? {} : { hits: detail.hits }),
        };
      });

    const documentChunks = (vaultId: Uuid, path: string) =>
      db
        .query((d) =>
          d
            .select({ count: sql<number>`count(*)::int` })
            .from(searchIndex)
            .where(
              and(
                eq(searchIndex.vaultId, vaultId),
                eq(searchIndex.path, path),
                gte(searchIndex.chunkIndex, 0),
              ),
            ),
        )
        .pipe(Effect.map((rows) => (first(rows)?.count ?? 0) || undefined));

    const sourceHits = (
      vaultId: Uuid,
      rows: readonly { readonly path: string; readonly chunkIndex: number }[],
    ) => {
      const byPath = new Map<string, number[]>();
      for (const row of rows) {
        const chunks = byPath.get(row.path);
        if (chunks !== undefined) chunks.push(row.chunkIndex);
        else if (byPath.size < maxSourceHits) byPath.set(row.path, [row.chunkIndex]);
      }
      return Effect.forEach(
        byPath,
        ([path, chunks]) =>
          documentForPath(vaultId, path).pipe(Effect.map(({ title }) => ({ path, title, chunks }))),
        { concurrency: 4 },
      );
    };

    const sectionOutline = (vaultId: Uuid, path: string) =>
      Effect.gen(function* () {
        const chunks = yield* db.query((d) =>
          d
            .select({
              chunkIndex: searchIndex.chunkIndex,
              heading: searchIndex.heading,
            })
            .from(searchIndex)
            .where(and(eq(searchIndex.vaultId, vaultId), eq(searchIndex.path, path)))
            .orderBy(asc(searchIndex.chunkIndex)),
        );
        const sections: { start: number; end: number; heading: string }[] = [];
        for (const chunk of chunks) {
          const last = sections[sections.length - 1];
          if (
            last === undefined ||
            last.heading !== chunk.heading ||
            last.end !== chunk.chunkIndex - 1
          ) {
            sections.push({
              start: chunk.chunkIndex,
              end: chunk.chunkIndex,
              heading: chunk.heading,
            });
          } else {
            last.end = chunk.chunkIndex;
          }
        }
        return sections;
      });

    const readDocumentTool = (
      context: QueryExecutionState,
      path: string,
      scope: OriginScope,
      emitSource = true,
    ): Effect.Effect<ToolResult, ToolMiss> =>
      Effect.gen(function* () {
        const read =
          scope === "personal"
            ? storage.readText(userOwner(context.userId), path)
            : storage.readText(vaultOwner(context.vaultId), path);
        const content = yield* read.pipe(
          Effect.mapError(() => new ToolMiss({ message: `Document not found: ${path}` })),
        );
        const chunks =
          scope === "personal" ? undefined : yield* documentChunks(context.vaultId, path);
        const readSource = (detail: SourceDetail) =>
          emitSource
            ? sourceEvent(
                context,
                { name: "read_document", args: { path } },
                { ...detail, ...(chunks === undefined ? {} : { chunks }) },
              )
            : Effect.succeed(undefined);
        if (scope === "personal" || content.length <= readWholeLimit) {
          return {
            content: `# ${path} [${context.vaultLabel}]\n\n${content}`,
            source: yield* readSource({ full: true }),
          };
        }
        const outline = yield* sectionOutline(context.vaultId, path);
        if (outline.length === 0)
          return {
            content:
              `# ${path} [${context.vaultLabel}]\n\n` +
              `This document is large (${content.length.toLocaleString("en-US")} chars) and is not searchable yet: indexing it for search has not completed, so search_in_document and expand_context cannot reach its text. Tell the user it is not searchable yet rather than treating it as empty.`,
            source: yield* readSource({}),
          };
        const lines = outline.map(
          (section) =>
            `- chunks ${section.start}-${section.end}: ${section.heading || "(no heading)"}`,
        );
        return {
          content:
            `# ${path} [${context.vaultLabel}]\n\n` +
            `This document is large (${content.length.toLocaleString("en-US")} chars) — do NOT read it from the top. To find the passages relevant to your question, call search_in_document(path, query). Use expand_context(path, start, end) only on a range a search hit or a specific section below points to.\n\n` +
            "Section outline (a map, not the text):\n\n" +
            lines.join("\n"),
          source: yield* readSource({ outline: true }),
        };
      });

    const searchRows = (
      context: Pick<QueryExecutionState, "vaultId" | "userId" | "correlationId">,
      query: string,
      path?: string,
    ) =>
      Effect.gen(function* () {
        const vaultId = context.vaultId;
        if (query.trim().length === 0) {
          return [];
        }
        const armLimit = maxSearchResults * searchArmMultiplier;
        const words = searchWords(query);
        const orJoined = words
          .slice(1)
          .reduce(
            (acc, word) => sql`${acc} || plainto_tsquery('english', ${word})`,
            sql`plainto_tsquery('english', ${words[0]})`,
          );
        const tsquery =
          words.length === 0 ? sql`plainto_tsquery('english', ${query})` : sql`(${orJoined})`;
        const bm25Conditions: SQL[] = [
          eq(searchIndex.vaultId, vaultId),
          sql`${searchIndex.tsv} @@ ${tsquery}`,
        ];
        const vectorConditions: SQL[] = [
          eq(searchIndex.vaultId, vaultId),
          sql`${searchIndex.embedding} is not null`,
        ];
        if (path !== undefined) {
          bm25Conditions.push(eq(searchIndex.path, path));
          vectorConditions.push(eq(searchIndex.path, path));
        }
        const rank = sql<number>`ts_rank(${searchIndex.tsv}, ${tsquery})`;
        const embedded = yield* embeddings.embed([searchQueryInput(query)], {
          vaultId,
          userId: context.userId,
          eventType: "query.embed",
          phase: "embed:search",
          correlationId: context.correlationId,
        });
        const queryEmbedding = embedded[0];
        if (queryEmbedding === undefined) {
          return [];
        }
        const distance = sql<number>`${searchIndex.embedding}::halfvec(1024) <=> ${vectorLiteral(queryEmbedding)}::halfvec(1024)`;
        const [bm25Rows, vectorRows] = yield* Effect.all(
          [
            db.query((d) =>
              d
                .select({
                  vaultId: searchIndex.vaultId,
                  path: searchIndex.path,
                  chunkIndex: searchIndex.chunkIndex,
                  heading: searchIndex.heading,
                  body: searchIndex.body,
                  score: rank,
                })
                .from(searchIndex)
                .where(and(...bm25Conditions))
                .orderBy(desc(rank))
                .limit(armLimit),
            ),
            db.query((d) =>
              d
                .select({
                  vaultId: searchIndex.vaultId,
                  path: searchIndex.path,
                  chunkIndex: searchIndex.chunkIndex,
                  heading: searchIndex.heading,
                  body: searchIndex.body,
                  score: sql<number>`1 - (${distance})`,
                })
                .from(searchIndex)
                .where(and(...vectorConditions))
                .orderBy(distance)
                .limit(armLimit),
            ),
          ],
          { concurrency: "unbounded" },
        );
        type SearchRow = (typeof bm25Rows)[number];
        type SearchKey = `${string}:${string}:${number}`;
        const scores = new Map<SearchKey, number>();
        const metadata = new Map<SearchKey, SearchRow>();
        const vectorRanks = new Map<SearchKey, number>();
        const bm25Ranks = new Map<SearchKey, number>();
        const keyFor = (row: SearchRow): SearchKey =>
          `${row.vaultId}:${row.path}:${row.chunkIndex}`;
        const addRows = (rows: readonly SearchRow[], ranks: Map<SearchKey, number>) => {
          rows.forEach((row, rankIndex) => {
            const key = keyFor(row);
            if (!scores.has(key)) {
              scores.set(key, 0);
              metadata.set(key, row);
            }
            ranks.set(key, rankIndex + 1);
            scores.set(key, (scores.get(key) ?? 0) + 1 / (rrfK + rankIndex + 1));
          });
        };
        addRows(bm25Rows, bm25Ranks);
        addRows(vectorRows, vectorRanks);
        return [...scores.entries()]
          .sort(([leftKey, leftScore], [rightKey, rightScore]) => {
            if (rightScore !== leftScore) {
              return rightScore - leftScore;
            }
            const leftVectorRank = vectorRanks.get(leftKey) ?? Number.POSITIVE_INFINITY;
            const rightVectorRank = vectorRanks.get(rightKey) ?? Number.POSITIVE_INFINITY;
            if (leftVectorRank !== rightVectorRank) {
              return leftVectorRank - rightVectorRank;
            }
            const leftBm25Rank = bm25Ranks.get(leftKey) ?? Number.POSITIVE_INFINITY;
            const rightBm25Rank = bm25Ranks.get(rightKey) ?? Number.POSITIVE_INFINITY;
            if (leftBm25Rank !== rightBm25Rank) {
              return leftBm25Rank - rightBm25Rank;
            }
            return leftKey.localeCompare(rightKey);
          })
          .slice(0, maxSearchResults)
          .flatMap(([key, score]) => {
            const row = metadata.get(key);
            return row === undefined
              ? []
              : [
                  {
                    ...row,
                    body: row.body.length > 500 ? row.body.slice(0, 500) : row.body,
                    score,
                  },
                ];
          });
      });

    const searchContentTool = (context: QueryExecutionState, query: string) =>
      Effect.gen(function* () {
        const results = yield* withFootnoteNotes(
          storage,
          context.vaultId,
          yield* searchRows(context, query),
        );
        const source = yield* sourceEvent(
          context,
          { name: "search_content", args: { query } },
          { results: results.length, hits: yield* sourceHits(context.vaultId, results) },
        );
        if (results.length === 0) {
          return { content: `No results found for: ${query}`, source } satisfies ToolResult;
        }
        const parts = results.map((row) => {
          const heading = row.heading.length > 0 ? ` — ${row.heading}` : "";
          return `### ${row.path} [chunk ${row.chunkIndex}]${heading}\n${row.body}`;
        });
        return {
          content:
            `Found ${results.length} results for '${query}'. Each result shows a document \`path\` and \`chunk_index\` — pass those to expand_context(path, start, end) to read the surrounding paragraphs, or read_document(path) for the whole document.\n\n` +
            parts.join("\n\n"),
          source,
        } satisfies ToolResult;
      });

    const searchInDocumentTool = (context: QueryExecutionState, path: string, query: string) =>
      Effect.gen(function* () {
        const results = yield* withFootnoteNotes(
          storage,
          context.vaultId,
          yield* searchRows(context, query, path),
        );
        const source = yield* sourceEvent(
          context,
          { name: "search_in_document", args: { path, query } },
          { results: results.length, hits: yield* sourceHits(context.vaultId, results) },
        );
        if (results.length === 0) {
          return {
            content: `No passages in ${path} match '${query}'. Check the path (from list_articles or a search_content hit), or use search_content to search the whole knowledge base.`,
            source,
          } satisfies ToolResult;
        }
        const parts = results.map((row) => {
          const heading = row.heading.length > 0 ? ` — ${row.heading}` : "";
          return `[chunk ${row.chunkIndex}]${heading}\n${row.body}`;
        });
        return {
          content:
            `Found ${results.length} matching passages in ${path}. Read more around any with expand_context(path, start, end).\n\n` +
            parts.join("\n\n"),
          source,
        } satisfies ToolResult;
      });

    const expandContextTool = (
      context: QueryExecutionState,
      path: string,
      rawStart: number,
      rawEnd: number,
    ) =>
      Effect.gen(function* () {
        const { start, end } = fetchRange(rawStart, rawEnd);
        const chunks = yield* chunkRange(db, storage, context.vaultId, path, start, end);
        if (chunks.length === 0) {
          return yield* new ToolMiss({
            message: `No indexed paragraphs at ${path} for chunks ${start}-${end}. Check the path and range against a search hit or document outline.`,
          });
        }
        const sections = chunks.map((chunk) => {
          const heading = chunk.heading.length > 0 ? `${chunk.heading}\n` : "";
          return `[chunk ${chunk.chunkIndex}]\n${heading}${chunk.body}`;
        });
        return {
          content:
            `# ${path} [${context.vaultLabel}] (chunks ${chunks[0].chunkIndex}–${chunks[chunks.length - 1].chunkIndex})\n\n` +
            sections.join("\n\n"),
          source: yield* sourceEvent(
            context,
            {
              name: "expand_context",
              args: {
                path,
                start: chunks[0].chunkIndex,
                end: chunks[chunks.length - 1].chunkIndex,
              },
            },
            { chunks: yield* documentChunks(context.vaultId, path) },
          ),
        } satisfies ToolResult;
      });

    const linkedArticlesTool = (context: QueryExecutionState, path: string) =>
      Effect.gen(function* () {
        if (!path.startsWith("wiki/")) {
          return yield* new ToolMiss({
            message: `${path} is not a wiki article — the link graph only covers wiki articles. Use search_content to find related material.`,
          });
        }
        const links = yield* articleLinks(db, context.vaultId, path);
        if (links === undefined) {
          return yield* new ToolMiss({ message: `Article not found: ${path}` });
        }
        const { outgoing, incoming } = links;
        const formatLinks = (rows: LinkedArticles["outgoing"]) =>
          rows.map((row) => `- [${row.title}](${row.file_path})`).join("\n") || "none";
        return {
          content:
            `# Links for ${path} [${context.vaultLabel}]\n\n` +
            `Outgoing (this article cites):\n${formatLinks(outgoing)}\n\n` +
            `Incoming (articles that cite this):\n${formatLinks(incoming)}`,
          source: yield* sourceEvent(
            context,
            { name: "linked_articles", args: { path } },
            { results: new Set([...outgoing, ...incoming].map((row) => row.file_path)).size },
          ),
        } satisfies ToolResult;
      });

    const queryDocumentsToolRun = (
      context: QueryExecutionState,
      args: Extract<QueryTool, { name: "query_documents" }>["args"],
    ) =>
      Effect.gen(function* () {
        const config = yield* vaultConfig(context.vaultId);
        const limit = Math.max(1, Math.min(50, args.limit ?? 20));
        const offset = Math.max(0, args.offset ?? 0);
        const page = yield* querySourceRows(
          db,
          context.vaultId,
          config,
          { ...args, limit, offset },
          20,
        ).pipe(Effect.mapError((error) => new ToolMiss({ message: error.detail })));
        const source = yield* sourceEvent(
          context,
          { name: "query_documents", args },
          { results: page.total },
        );
        if (page.rows.length === 0) {
          const filters = Object.fromEntries(
            truthyEntries({ ...args, limit, offset: offset === 0 ? undefined : offset }),
          );
          return {
            content:
              page.total === 0
                ? `No documents match the filters: ${JSON.stringify(filters)}`
                : `No documents past offset ${offset}; ${page.total} match the filters: ${JSON.stringify(filters)}`,
            source,
          } satisfies ToolResult;
        }
        const declared = config.enrichedFields.map((field) => field.name);
        const summaries = yield* Effect.forEach(page.rows, readSourceSummary);
        const parts = summaries.map((row) => {
          const lines = [`### ${row.title ?? row.file_path}`, `  [raw] ${row.file_path}`];
          if (row.author !== null) lines[1] += ` by ${row.author}`;
          if (row.published_date !== null) lines[1] += ` (${row.published_date})`;
          if (row.genre !== null) lines.push(`  genre: ${row.genre}`);
          if (row.tags.length > 0) lines.push(`  tags: ${row.tags.join(", ")}`);
          for (const name of declared) {
            const value = row.derived_extras[name];
            const shown = Array.isArray(value) ? value.join(", ") : value;
            if (typeof shown === "string" && shown !== "") lines.push(`  ${name}: ${shown}`);
          }
          return lines.join("\n");
        });
        const last = offset + page.rows.length;
        const more =
          last < page.total
            ? ` Call again with offset ${last} for the next ${Math.min(limit, page.total - last)}.`
            : "";
        return {
          content: `Showing ${offset + 1}-${last} of ${page.total} documents.${more}\n\n${parts.join("\n\n")}`,
          source,
        } satisfies ToolResult;
      });

    const listArticlesToolRun = (
      context: QueryExecutionState,
      args: Extract<QueryTool, { name: "list_articles" }>["args"],
    ) =>
      Effect.gen(function* () {
        const { contains, sort = "central" } = args;
        const page = Math.max(1, args.page ?? 1);
        const offset = (page - 1) * articlesPerPage;
        const listed = yield* listArticlePage(
          db,
          { limit: articlesPerPage, offset },
          listedArticleConditions(context.vaultId, contains ? { contains } : {}),
          articleOrder[sort === "central" ? "linked" : sort === "alpha" ? "title" : "recent"],
        );
        const total = listed.pagination.total;
        const rows = listed.items;
        const source = yield* sourceEvent(
          context,
          { name: "list_articles", args },
          { results: total },
        );
        if (rows.length === 0) {
          return {
            content: contains
              ? `No article titles or precis contain '${contains}'. Try search_content for topical matches — it searches article bodies and raw sources too.`
              : "No wiki articles have been compiled yet.",
            source,
          } satisfies ToolResult;
        }
        const hi = offset + rows.length;
        const scope = contains ? ` matching '${contains}'` : "";
        const lines = rows.map((row) => `- ${row.title} — ${row.file_path}\n  ${row.precis}`);
        const more =
          hi < total
            ? `\n\nMore available — call list_articles(page=${page + 1}) to continue.`
            : "";
        return {
          content:
            `Articles ${offset + 1}–${hi} of ${total}${scope} (by ${sort}):\n\n` +
            lines.join("\n") +
            more,
          source,
        } satisfies ToolResult;
      });

    const addUsageCost = (
      context: QueryExecutionState,
      usage: { readonly cost?: number } | undefined,
    ) => {
      if (usage?.cost === undefined) {
        return false;
      }
      if (Number.isFinite(usage.cost) && usage.cost > 0) {
        context.costUsd += usage.cost;
      }
      return true;
    };

    const addFallbackGenerationCosts = (context: QueryExecutionState) =>
      Effect.forEach(
        context.fallbackGenerationIds,
        (generationId) =>
          costs.lookupGenerationCost(generationId).pipe(
            Effect.map((cost) => {
              if (cost !== null && Number.isFinite(cost) && cost > 0) {
                context.costUsd += cost;
              }
            }),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : logger.warn("query.cost_lookup_failed", {
                    correlation_id: context.correlationId,
                    generation_id: generationId,
                    ...logErrorFields(Cause.squash(cause)),
                  }),
            ),
          ),
        { discard: true },
      );

    const addGenerationCostFallback = (
      context: QueryExecutionState,
      generationId: string | undefined,
    ) => {
      if (generationId !== undefined) {
        context.fallbackGenerationIds.push(generationId);
      }
    };

    const extractWebFacts = (
      context: QueryExecutionState,
      query: string,
      results: readonly ParallelSearchResult[],
    ) =>
      Effect.gen(function* () {
        const numbered = results.map((result, index) => {
          const content = result.excerpts.join(" ");
          return `[${index + 1}] ${result.title}\n${result.url}\n${content}`;
        });
        const completion = yield* languageModel.complete({
          model: appConfig.extractModel,
          temperature: Option.getOrUndefined(appConfig.extractTemperature),
          reasoningEffort: Option.getOrUndefined(appConfig.extractReasoningEffort),
          responseFormat: "json_object",
          messages: [
            { role: "system", content: webFactExtractionPrompt },
            {
              role: "user",
              content: `USER QUESTION: ${context.question}\n\nWEB RESULTS:\n\n${numbered.join("\n\n")}`,
            },
          ],
        });
        addUsageCost(context, completion.usage);
        const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(WebFactExtraction))(
          stripJsonFence(completion.text),
        ).pipe(
          Effect.mapError(
            (error) =>
              new ModelProviderError({
                message: "Invalid web fact extraction response",
                issue: error.issue,
              }),
          ),
        );
        return new Map<number, readonly string[]>(
          parsed.results.map((item) => [item.index, item.facts]),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : logger
                .warn("query.web_extract_failed", {
                  correlation_id: context.correlationId,
                  query,
                  ...logErrorFields(Cause.squash(cause)),
                })
                .pipe(Effect.as(undefined)),
        ),
      );

    const webSearchToolRun = (context: QueryExecutionState, query: string) =>
      Effect.gen(function* () {
        const source = yield* sourceEvent(context, { name: "web_search", args: { query } });
        return yield* Effect.gen(function* () {
          const results = yield* parallel.search({ question: context.typedQuestion, query });
          const found = source.type === "search" ? { ...source, results: results.length } : source;
          if (results.length === 0) {
            return {
              content: `No web results for '${query}'.`,
              source: found,
            } satisfies ToolResult;
          }
          const facts = yield* extractWebFacts(context, query, results);
          if (facts === undefined) {
            return {
              content: `Web results for '${query}' could not be distilled to facts this call; rely on the knowledge base.`,
              source: found,
            } satisfies ToolResult;
          }
          const blocks = results.map((result, index) => {
            const extracted = facts.get(index + 1) ?? [];
            const body =
              extracted.length > 0
                ? extracted.map((fact) => `- ${fact}`).join("\n")
                : "(no extractable facts)";
            return `### ${result.title}\n${result.url}\n${body}`;
          });
          return {
            content:
              `Web FACTS for '${query}' — EXTERNAL, not from the knowledge base. These are facts only; the analysis is yours, from the knowledge base. Cite a fact's source as [title](url):\n\n` +
              blocks.join("\n\n"),
            source: found,
          } satisfies ToolResult;
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : logger
                  .warn("query.web_search_failed", {
                    correlation_id: context.correlationId,
                    query,
                    ...logErrorFields(Cause.squash(cause)),
                  })
                  .pipe(
                    Effect.as({
                      content: `Web search failed for '${query}'. Rely on the knowledge base or rephrase.`,
                      source,
                    } satisfies ToolResult),
                  ),
          ),
        );
      });

    const dispatchTool = (
      context: QueryExecutionState,
      tool: QueryTool,
    ): Effect.Effect<ToolResult, ToolMiss | EmbeddingBatchFailed> => {
      switch (tool.name) {
        case "read_document":
          return readDocumentTool(context, tool.args.path, "vault");
        case "expand_context":
          return expandContextTool(context, tool.args.path, tool.args.start, tool.args.end);
        case "linked_articles":
          return linkedArticlesTool(context, tool.args.path);
        case "search_content":
          return searchContentTool(context, tool.args.query);
        case "search_in_document":
          return searchInDocumentTool(context, tool.args.path, tool.args.query);
        case "query_documents":
          return queryDocumentsToolRun(context, tool.args);
        case "list_articles":
          return listArticlesToolRun(context, tool.args);
        case "web_search":
          return webSearchToolRun(context, tool.args.query);
      }
    };

    const runModelRound = (
      context: QueryExecutionState,
      model: string,
      onToken: (text: string) => Effect.Effect<void>,
    ) =>
      Effect.gen(function* () {
        const state: ModelRoundState = {
          content: "",
          reasoning: "",
          finishReason: null,
          toolCalls: new Map(),
        };
        yield* languageModel
          .streamChat({
            model,
            messages: context.messages,
            tools: context.tools,
            temperature: Option.getOrUndefined(appConfig.queryTemperature),
            reasoningEffort: Option.getOrUndefined(appConfig.queryReasoningEffort),
          })
          .pipe(
            Stream.runForEach((part) => {
              if (part.type === "token") {
                state.content += part.text;
                return onToken(part.text);
              }
              if (part.type === "reasoning") {
                state.reasoning += part.text;
                return Effect.void;
              }
              if (part.type === "tool_call_delta") {
                const current = state.toolCalls.get(part.delta.index) ?? {
                  id: "",
                  name: "",
                  arguments: "",
                };
                state.toolCalls.set(part.delta.index, {
                  id: part.delta.id ?? current.id,
                  name: part.delta.name ?? current.name,
                  arguments: current.arguments + (part.delta.argumentsDelta ?? ""),
                });
                return Effect.void;
              }
              state.finishReason = part.finishReason;
              if (!addUsageCost(context, part.usage)) {
                addGenerationCostFallback(context, part.generationId);
              }
              return Effect.void;
            }),
          );
        return state;
      });

    const modelRoundFailed = (
      context: QueryExecutionState,
      model: string,
      error: RetryableModelError | ModelProviderError,
    ): Effect.Effect<QueryModelAttemptResult> =>
      Effect.gen(function* () {
        const transient = error._tag === "RetryableModelError" || error.transient === true;
        const fields = { correlation_id: context.correlationId, model, ...logErrorFields(error) };
        yield* transient
          ? logger.warn("query.stream_retryable", fields)
          : logger.error("query.stream_failed", fields);
        if (!transient || context.modelIndex + 1 >= context.models.length)
          return { kind: "failed", error: sanitizedStreamError };
        context.modelIndex += 1;
        return { kind: "retryable" };
      });

    const executeModelAttempt = (
      context: QueryExecutionState,
      onToken: (text: string) => Effect.Effect<void>,
    ): Effect.Effect<QueryModelAttemptResult> =>
      Effect.gen(function* () {
        const model = context.models[context.modelIndex];
        if (model === undefined)
          return { kind: "failed", error: sanitizedStreamError } satisfies QueryModelAttemptResult;
        const messages = context.messages;
        context.selectedModel = model;
        context.trace.llmRounds += 1;
        yield* logger.info("query.stream_tool_round_start", {
          correlation_id: context.correlationId,
          model,
          round: context.trace.llmRounds,
        });
        const round = yield* Effect.result(
          runModelRound(context, model, onToken).pipe(
            Effect.tapDefect((defect) =>
              logger.error("query.stream_failed", {
                correlation_id: context.correlationId,
                model,
                ...logErrorFields(defect),
              }),
            ),
          ),
        );
        if (round._tag === "Failure") {
          return yield* modelRoundFailed(context, model, round.failure);
        }
        const roundState = round.success;
        if (roundState.finishReason === "tool_calls" && roundState.toolCalls.size > 0) {
          const rawToolCalls = [...roundState.toolCalls.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, toolCall]) => toolCall);
          const toolCalls: QueryPreparedToolCall[] = [];
          for (const toolCall of rawToolCalls) {
            const tool = yield* Effect.option(parseTool(toolCall));
            toolCalls.push({
              ...toolCall,
              ...(Option.isSome(tool) ? { pendingSource: pendingSourceEvent(tool.value) } : {}),
            });
          }
          messages.push({
            role: "assistant",
            content: roundState.content.length === 0 ? null : roundState.content,
            ...(roundState.reasoning.length === 0
              ? {}
              : { reasoning_content: roundState.reasoning }),
            tool_calls: rawToolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: "function",
              function: {
                name: toolCall.name,
                arguments: Option.isSome(jsonArguments(toolCall.arguments))
                  ? toolCall.arguments
                  : "{}",
              },
            })),
          });
          return {
            kind: "tool_calls",
            toolCalls,
          } satisfies QueryModelAttemptResult;
        }
        if (roundState.finishReason === "length" || roundState.content.length === 0)
          return {
            kind: "failed",
            error:
              roundState.finishReason === "length" ? truncatedAnswerError : sanitizedStreamError,
          } satisfies QueryModelAttemptResult;
        messages.push({
          role: "assistant",
          content: roundState.content,
          ...(roundState.reasoning.length === 0 ? {} : { reasoning_content: roundState.reasoning }),
        });
        return {
          kind: "done",
        } satisfies QueryModelAttemptResult;
      });

    const logToolFailure = (context: QueryExecutionState, error: unknown) =>
      logger.error("query.stream_failed", {
        correlation_id: context.correlationId,
        model: context.selectedModel,
        ...logErrorFields(error),
      });

    const executeTool = (context: QueryExecutionState, toolCall: QueryPreparedToolCall) =>
      Effect.gen(function* () {
        context.trace.toolCalls += 1;
        const result = yield* Effect.flatMap(parseTool(toolCall), (tool) =>
          dispatchTool(context, tool),
        ).pipe(
          Effect.catchTag("ToolMiss", (error) =>
            Effect.succeed<ToolResult>({ content: error.message }),
          ),
          Effect.tapError((error) => logToolFailure(context, error)),
          Effect.tapDefect((defect) => logToolFailure(context, defect)),
        );
        context.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result.content,
        });
        if (result.source?.type === "article") context.trace.articlesRead += 1;
        else if (result.source?.type === "raw") context.trace.sourcesRead += 1;
        else if (result.source?.type === "search") context.trace.searches += 1;
        return result.source;
      });

    const buildOriginMessages = (
      context: QueryExecutionState,
      originPath: string,
      originScope: OriginScope,
    ) =>
      Effect.gen(function* () {
        const content = yield* readDocumentTool(context, originPath, originScope, false).pipe(
          Effect.map((result) => result.content),
          Effect.catchTag("ToolMiss", (error) => Effect.succeed(error.message)),
        );
        const toolCallId = `origin-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
        return [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: toolCallId,
                type: "function",
                function: {
                  name: "read_document",
                  arguments: JSON.stringify({ path: originPath }),
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: toolCallId,
            content,
          },
        ] satisfies LlmMessage[];
      });

    const setupContext = (
      userId: Uuid,
      vaultId: Uuid,
      input: QueryInput,
      correlationId: string,
      startedAt: number,
      prior: readonly LlmMessage[],
    ) =>
      Effect.gen(function* () {
        const vaultLabel = input.vaultLabel;
        const [config, tags] = yield* Effect.all([vaultConfig(vaultId), distinctTags(vaultId)], {
          concurrency: "unbounded",
        });
        const webSearchEnabled = config.webSearch && parallel.hasApiKey;
        const systemPrompt = yield* buildSystemPrompt(
          vaultId,
          vaultLabel,
          config,
          input.mode,
          webSearchEnabled,
        );
        const systemPromptHash = promptContentHash(systemPrompt);
        yield* recordPrompt(db, systemPromptHash, systemPrompt);
        const context: QueryExecutionState = {
          userId,
          vaultId,
          question: input.question,
          typedQuestion: input.typedQuestion,
          vaultLabel,
          mode: input.mode,
          correlationId,
          tools: toolDefinitions(tags, config.enrichedFields, webSearchEnabled),
          turnStart: 1 + prior.length,
          webSearchEnabled,
          trace: {
            articlesRead: 0,
            sourcesRead: 0,
            searches: 0,
            llmRounds: 0,
            toolCalls: 0,
          },
          fallbackGenerationIds: [],
          systemPromptHash,
          costUsd: 0,
          selectedModel: null,
          models: [
            appConfig.queryModel,
            ...appConfig.queryFallbackModels.filter((model) => model !== appConfig.queryModel),
          ],
          modelIndex: 0,
          startedAt,
          messages: [{ role: "system", content: systemPrompt }],
        };
        const messages = context.messages;
        if (prior.length === 0 && input.originPath !== undefined && input.originPath.length > 0) {
          messages.push(
            ...(yield* buildOriginMessages(context, input.originPath, input.originScope)),
          );
        }
        messages.push(...prior);
        messages.push({ role: "user", content: input.question + lengthCues[input.mode] });
        return context;
      });

    const finalize = (context: QueryExecutionState) =>
      Effect.gen(function* () {
        if (context.costUsd > 0) {
          yield* db
            .query((d) =>
              d
                .insert(llmCostEvents)
                .values({
                  userId: existingUser(context.userId),
                  vaultId: context.vaultId,
                  eventType: "query.stream",
                  costUsd: context.costUsd.toFixed(6),
                  correlationId: context.correlationId,
                  model: context.selectedModel,
                  promptHash: context.systemPromptHash,
                })
                .onConflictDoNothing(),
            )
            .pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : logger.error("query.cost_write_failed", {
                      correlation_id: context.correlationId,
                      ...logErrorFields(Cause.squash(cause)),
                    }),
              ),
            );
        }
        yield* logger.info("query.stream_finalize", {
          correlation_id: context.correlationId,
          user_id: context.userId,
          vault_id: context.vaultId,
          mode: context.mode,
          model: context.selectedModel,
          web_search: context.webSearchEnabled,
          articles_read: context.trace.articlesRead,
          sources_read: context.trace.sourcesRead,
          searches: context.trace.searches,
          llm_rounds: context.trace.llmRounds,
          tool_calls: context.trace.toolCalls,
          cost_usd: Number(context.costUsd.toFixed(6)),
          duration_ms: (yield* clock.now).getTime() - context.startedAt,
        });
      });

    const prepareExecution = (
      userId: Uuid,
      vaultId: Uuid,
      input: QueryInput,
      prior: readonly LlmMessage[],
    ) =>
      Effect.gen(function* () {
        const startedAt = (yield* clock.now).getTime();
        const correlationId = `q-${randomUUID()}`;
        return yield* Effect.gen(function* () {
          const context = yield* setupContext(
            userId,
            vaultId,
            input,
            correlationId,
            startedAt,
            prior,
          );
          yield* logger.info("query.stream_start", {
            correlation_id: context.correlationId,
            user_id: userId,
            vault_id: vaultId,
            mode: context.mode,
            question_length: input.question.length,
            web_search: context.webSearchEnabled,
          });
          return context;
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : logger
                  .error("query.stream_setup_failed", {
                    correlation_id: correlationId,
                    vault_id: vaultId,
                    user_id: userId,
                    ...logErrorFields(Cause.squash(cause)),
                  })
                  .pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        );
      });

    return {
      prepareExecution,
      modelAttempt: executeModelAttempt,
      runTool: executeTool,
      finalizeExecution: (state) =>
        Effect.gen(function* () {
          yield* addFallbackGenerationCosts(state);
          yield* finalize(state);
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : logger.error("query.stream_finalize_failed", {
                  correlation_id: state.correlationId,
                  vault_id: state.vaultId,
                  user_id: state.userId,
                  ...logErrorFields(Cause.squash(cause)),
                }),
          ),
        ),
      search: (userId, vaultId, query, path) =>
        Effect.gen(function* () {
          const rows = yield* withFootnoteNotes(
            storage,
            vaultId,
            yield* searchRows(
              { vaultId, userId, correlationId: `search-${randomUUID()}` },
              query,
              path,
            ),
          );
          return rows.map((row): SearchHit => ({
            path: row.path,
            chunk_index: row.chunkIndex,
            heading: row.heading,
            text: row.body,
            score: row.score,
          }));
        }),
      draftHint: (_userId, description) =>
        Effect.gen(function* () {
          const missingKey = missingModelKey(appConfig, appConfig.queryModel);
          if (missingKey !== undefined) {
            return yield* new ServiceUnavailable({ detail: notConfiguredDetail(missingKey) });
          }
          const trimmed = description.trim();
          if (trimmed.length === 0) {
            return yield* new BadRequest({ detail: "description required" });
          }
          const completion = yield* languageModel
            .complete({
              model: appConfig.queryModel,
              temperature: Option.getOrUndefined(appConfig.queryTemperature),
              reasoningEffort: Option.getOrUndefined(appConfig.queryReasoningEffort),
              messages: [
                { role: "system", content: draftHintSystem },
                { role: "user", content: trimmed },
              ],
            })
            .pipe(
              Effect.mapError(
                () =>
                  new ServiceUnavailable({
                    detail: "The model provider is unavailable. Try again in a minute.",
                  }),
              ),
            );
          return { thematic_hint: completion.text } satisfies DraftHintResponse;
        }),
    } satisfies QueryServiceShape;
  }),
);
