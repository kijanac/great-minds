import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  backlinks,
  Database,
  llmCostEvents,
  searchIndex,
  sourceDocuments,
  wikiArticles,
} from "@great-minds/database";
import {
  BadRequest,
  ServiceUnavailable,
  type DraftHintResponse,
  type HistoryMessage,
  type OriginScope,
  type QueryRequest,
  type QuerySourceData,
  QuerySourceData as QuerySourceDataSchema,
  type QueryStreamPayload,
  type Uuid,
  Uuid as UuidSchema,
} from "@great-minds/domain";
import { and, asc, desc, eq, gte, ilike, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Schema, Stream } from "effect";
import { parse as parseYaml } from "yaml";

import { AppConfig } from "./config.ts";
import { promptContentHash } from "./crypto.ts";
import { EmbeddingsService } from "./embeddings.ts";
import { CostLookupService, recordPrompt } from "./llm-costs.ts";
import {
  isRetryableModelError,
  LanguageModel,
  type LlmMessage,
  type LlmToolDefinition,
} from "./llm.ts";
import { StructuredLogger } from "./logging.ts";
import { ParallelSearchService, type ParallelSearchResult } from "./parallel.ts";
import { ContentStorage, userOwner, vaultOwner } from "./storage.ts";

type QueryServiceShape = {
  readonly prepareExecution: (
    userId: Uuid,
    vaultId: Uuid,
    input: QueryRequest,
    prechecked: QueryPrecheckedContext,
  ) => Effect.Effect<QueryExecutionState, unknown>;
  readonly modelAttempt: (
    state: QueryExecutionState,
    emit: (payload: QueryStreamPayload) => Effect.Effect<void>,
  ) => Effect.Effect<QueryModelAttemptResult, unknown>;
  readonly runTool: (
    state: QueryExecutionState,
    toolCall: QueryPreparedToolCall,
  ) => Effect.Effect<QueryToolExecutionResult, unknown>;
  readonly finalizeExecution: (state: QueryExecutionState) => Effect.Effect<void>;
  readonly draftHint: (
    userId: Uuid,
    description: string,
  ) => Effect.Effect<DraftHintResponse, BadRequest | ServiceUnavailable>;
};

export class QueryService extends Context.Service<QueryService, QueryServiceShape>()(
  "@great-minds/server/QueryService",
) {}

type ToolCallState = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
};

const LlmTextContentPartSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  cache_control: Schema.optionalKey(Schema.Struct({ type: Schema.Literal("ephemeral") })),
});

const LlmAssistantToolCallSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
});

const LlmMessageSchema = Schema.Union([
  Schema.Struct({
    role: Schema.Literals(["system", "user", "assistant"] as const),
    content: Schema.Union([
      Schema.String,
      Schema.Null,
      Schema.Array(LlmTextContentPartSchema),
    ]),
    tool_calls: Schema.optionalKey(Schema.Array(LlmAssistantToolCallSchema)),
  }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    tool_call_id: Schema.String,
    content: Schema.String,
  }),
]);

const LlmToolDefinitionSchema = Schema.Struct({
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    parameters: Schema.Record(Schema.String, Schema.Unknown),
  }),
});

const QueryTraceSchema = Schema.Struct({
  articlesRead: Schema.Array(Schema.String),
  sourcesRead: Schema.Array(Schema.String),
  searches: Schema.Array(Schema.String),
  llmRounds: Schema.Number,
  toolCalls: Schema.Number,
});

export const QueryExecutionState = Schema.Struct({
  userId: UuidSchema,
  vaultId: UuidSchema,
  question: Schema.String,
  vaultLabel: Schema.String,
  mode: Schema.Literals(["query", "btw"] as const),
  correlationId: Schema.String,
  tools: Schema.Array(LlmToolDefinitionSchema),
  messages: Schema.Array(LlmMessageSchema),
  webSearchEnabled: Schema.Boolean,
  trace: QueryTraceSchema,
  fallbackGenerationIds: Schema.Array(Schema.String),
  systemPromptHash: Schema.String,
  costUsd: Schema.Number,
  selectedModel: Schema.NullOr(Schema.String),
  models: Schema.Array(Schema.String),
  modelIndex: Schema.Number,
  startedAt: Schema.Number,
});
export type QueryExecutionState = typeof QueryExecutionState.Type;

export const QueryPreparedToolCall = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
  args: Schema.Record(Schema.String, Schema.Unknown),
  pendingSource: Schema.optionalKey(QuerySourceDataSchema),
});
export type QueryPreparedToolCall = typeof QueryPreparedToolCall.Type;

type QueryModelAttemptResult =
  | { readonly kind: "retryable"; readonly state: QueryExecutionState }
  | { readonly kind: "failed"; readonly state: QueryExecutionState; readonly error: string }
  | { readonly kind: "done"; readonly state: QueryExecutionState }
  | {
      readonly kind: "tool_calls";
      readonly state: QueryExecutionState;
      readonly toolCalls: readonly QueryPreparedToolCall[];
    };

type QueryToolExecutionResult = {
  readonly state: QueryExecutionState;
  readonly source?: QuerySourceData;
};

type ModelRoundState = {
  content: string;
  finishReason: string | null;
  readonly toolCalls: Map<number, ToolCallState>;
};

type Trace = {
  readonly articlesRead: string[];
  readonly sourcesRead: string[];
  readonly searches: string[];
  llmRounds: number;
  toolCalls: number;
};

type QueryVaultConfig = {
  readonly thematicHint: string;
  readonly kinds: readonly string[];
  readonly webSearch: boolean;
};

type QueryContext = {
  readonly userId: Uuid;
  readonly vaultId: Uuid;
  readonly question: string;
  readonly vaultLabel: string;
  readonly mode: "query" | "btw";
  readonly correlationId: string;
  readonly tools: readonly LlmToolDefinition[];
  readonly baseMessages: readonly LlmMessage[];
  readonly webSearchEnabled: boolean;
  readonly trace: Trace;
  readonly fallbackGenerationIds: string[];
  readonly systemPromptHash: string;
  costUsd: number;
  selectedModel?: string;
};

export type QueryPrecheckedContext = {
  readonly vaultLabel: string;
};

type ToolResult = {
  readonly content: string;
  readonly source?: QuerySourceData;
};

type SafeLogFields = Record<string, string | number | boolean | null | undefined>;

class ToolMiss extends Error {
  readonly toolMessage: string;

  constructor(toolMessage: string) {
    super(toolMessage);
    this.name = "ToolMiss";
    this.toolMessage = toolMessage;
  }
}

class MalformedToolArgs extends Error {
  constructor(toolName: string) {
    super(`Malformed tool args for ${toolName}`);
    this.name = "MalformedToolArgs";
  }
}

const sanitizedStreamError = "Something went wrong while answering. Try again in a minute.";
const readWholeLimit = 20_000;
const maxRangeChunks = 40;
const articlesPerPage = 25;
const configPath = "config.yaml";
const rrfK = 60;
const maxSearchResults = 20;
const searchArmMultiplier = 2;

const defaultQueryVaultConfig = {
  thematicHint: "",
  kinds: ["person", "event", "organization", "concept"],
  webSearch: false,
} satisfies QueryVaultConfig;

const first = <A>(values: readonly A[]) => values[0];

const promptUrl = (name: string) => new URL(`./default_prompts/${name}.md`, import.meta.url);

const emptyTrace = (): Trace => ({
  articlesRead: [],
  sourcesRead: [],
  searches: [],
  llmRounds: 0,
  toolCalls: 0,
});

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

const isInterruptOnly = (cause: Cause.Cause<unknown>) =>
  cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason);

const causeError = (cause: Cause.Cause<unknown>): unknown => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      return reason.error;
    }
  }
  for (const reason of cause.reasons) {
    if (Cause.isDieReason(reason)) {
      return reason.defect;
    }
  }
  return cause;
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

const baseTools: readonly LlmToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_document",
      description:
        "Use to read a document you already have the `path` for. A small document is returned in full; a LARGE document returns only a section OUTLINE, not its text. If you have a query and the document is large, do NOT use this to read it — use search_in_document(path, query) to jump to the relevant passages. Read an outlined section with expand_context(path, start, end).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Document path, e.g. wiki/capitalism.md or raw/texts/lenin/works/1893/market/02.md",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "expand_context",
      description:
        "Use to fetch a specific `start`-`end` chunk range you ALREADY obtained from a search hit or a read_document outline. Do NOT use it to explore a document — guessing a range (e.g. chunks 1-10) wastes turns; run search_in_document(path, query) first and expand only the chunks it returns.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Document path from a search result or outline, e.g. raw/texts/lenin/works/1916/imperialism/03.md",
          },
          start: { type: "integer", description: "First chunk index to read (inclusive)" },
          end: { type: "integer", description: "Last chunk index to read (inclusive)" },
        },
        required: ["path", "start", "end"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "linked_articles",
      description:
        "Use when you have a wiki article `path` and want its neighbors in the citation graph — outgoing and incoming links — to follow related articles without reading their bodies. Returns linked titles + paths only. Do NOT use it to find passages or do topical search (use search_content / search_in_document). Pass a wiki article path, e.g. wiki/imperialism.md.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Wiki article path, e.g. wiki/imperialism.md (from a search hit or another article's links)",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_content",
      description:
        "Use FIRST only when you don't yet know which document holds the answer — hybrid search across the WHOLE knowledge base (all raw sources + all wiki articles), matching title, precis, author, and body text. Returns ranked excerpts each with a `path` and `chunk_index`. Once you have a specific path, do NOT search here again — use search_in_document to search inside it, or read_document to read it.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term or phrase" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_articles",
      description:
        "Use to BROWSE the wiki article index — the synthesized encyclopedia — by title and path, most-linked first (sort=central). Reach for it FIRST to orient on a concept, person, work, or '-ism', or to find a known article's real path before reading it. Returns titles + paths only, no body text. `contains` is a literal title/precis substring filter — for topical or fuzzy discovery use search_content instead.",
      parameters: {
        type: "object",
        properties: {
          contains: {
            type: "string",
            description:
              "Literal substring to match in an article's title/precis (not semantic — use search_content for meaning-based discovery)",
          },
          sort: {
            type: "string",
            enum: ["central", "recent", "alpha"],
            description:
              "central = most-linked first (best for orientation), recent = newest first, alpha = A–Z. Default central.",
          },
          page: { type: "integer", description: "1-based page number (default 1)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_in_document",
      description:
        "Use when you HAVE a document `path` and want the passages of THAT document relevant to a query — hybrid search scoped to one document. ALWAYS prefer this over read_document + expand_context for any document large enough to return an outline: it finds the relevant chunks instead of making you guess a range. Returns matching chunks with indexes for expand_context(path, start, end).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Document path to search within, e.g. raw/texts/lenin/works/1916/imperialism/03.md",
          },
          query: { type: "string", description: "Search term or phrase" },
        },
        required: ["path", "query"],
      },
    },
  },
];

const webSearchTool: LlmToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the open web for facts the knowledge base does not contain — recent events, dates, figures, names. Use ONLY after the knowledge base has come up empty on a factual point; the knowledge base remains the source for analysis and interpretation. Results are EXTERNAL: cite them as [title](url) and make clear they are from the web, not the knowledge base.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Web search query" },
      },
      required: ["query"],
    },
  },
};

const queryDocumentsTool = (tags: readonly string[]): LlmToolDefinition => ({
  type: "function",
  function: {
    name: "query_documents",
    description:
      "Use when the question names a STRUCTURED attribute of raw sources — a tag, author, genre, or date/date-range (e.g. 'sources by X', 'everything tagged Y', 'written after Z'). Filters by metadata, not text content. Do NOT use it for topical/conceptual questions (use search_content), and do NOT use it for wiki articles (use list_articles). " +
      (tags.length > 0 ? `Available tags: ${tags.join(", ")}.` : "No tags yet."),
    parameters: {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags (all must match)",
        },
        author: { type: "string", description: "Filter by author name (partial match)" },
        genre: { type: "string", description: "Filter by genre (e.g. theoretical, polemical)" },
        date_gte: { type: "string", description: "Published on or after this date/year" },
        date_lte: { type: "string", description: "Published on or before this date/year" },
        limit: { type: "integer", description: "Max results (default 20)" },
      },
    },
  },
});

const cloneMessages = (messages: readonly LlmMessage[]): LlmMessage[] =>
  messages.map((message) => {
    if (message.role === "tool") {
      return { ...message };
    }
    return {
      ...message,
      tool_calls: message.tool_calls?.map((toolCall) => ({
        ...toolCall,
        function: { ...toolCall.function },
      })),
    };
  });

const executionState = (
  context: QueryContext,
  messages: readonly LlmMessage[],
  models: readonly string[],
  modelIndex: number,
  startedAt: number,
): QueryExecutionState => ({
  userId: context.userId,
  vaultId: context.vaultId,
  question: context.question,
  vaultLabel: context.vaultLabel,
  mode: context.mode,
  correlationId: context.correlationId,
  tools: [...context.tools],
  messages: cloneMessages(messages),
  webSearchEnabled: context.webSearchEnabled,
  trace: {
    articlesRead: [...context.trace.articlesRead],
    sourcesRead: [...context.trace.sourcesRead],
    searches: [...context.trace.searches],
    llmRounds: context.trace.llmRounds,
    toolCalls: context.trace.toolCalls,
  },
  fallbackGenerationIds: [...context.fallbackGenerationIds],
  systemPromptHash: context.systemPromptHash,
  costUsd: context.costUsd,
  selectedModel: context.selectedModel ?? null,
  models: [...models],
  modelIndex,
  startedAt,
});

const contextFromExecution = (state: QueryExecutionState): QueryContext => ({
  userId: state.userId,
  vaultId: state.vaultId,
  question: state.question,
  vaultLabel: state.vaultLabel,
  mode: state.mode,
  correlationId: state.correlationId,
  tools: [...state.tools],
  baseMessages: cloneMessages(state.messages),
  webSearchEnabled: state.webSearchEnabled,
  trace: {
    articlesRead: [...state.trace.articlesRead],
    sourcesRead: [...state.trace.sourcesRead],
    searches: [...state.trace.searches],
    llmRounds: state.trace.llmRounds,
    toolCalls: state.trace.toolCalls,
  },
  fallbackGenerationIds: [...state.fallbackGenerationIds],
  systemPromptHash: state.systemPromptHash,
  costUsd: state.costUsd,
  ...(state.selectedModel === null ? {} : { selectedModel: state.selectedModel }),
});

const asStringArg = (args: Record<string, unknown>, key: string) => {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Tool argument ${key} must be a non-empty string`);
  }
  return value;
};

const asIntArg = (args: Record<string, unknown>, key: string) => {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^[-+]?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  throw new Error(`Tool argument ${key} must be an integer`);
};

const asObjectArgs = (json: string, toolName: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new MalformedToolArgs(toolName);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be an object");
  }
  return parsed as Record<string, unknown>;
};

const truthyEntries = (args: Record<string, unknown>) =>
  Object.entries(args).filter(([, value]) => Boolean(value));

const vectorLiteral = (embedding: readonly number[]) => `[${embedding.join(",")}]`;

const stripMarkdownJsonFence = (raw: string) =>
  raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

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

    const loadVaultConfig = (vaultId: Uuid) =>
      storage.readText(vaultOwner(vaultId), configPath).pipe(
        Effect.map((content) => {
          const parsed = parseYaml(content) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return defaultQueryVaultConfig;
          }
          const record = parsed as Record<string, unknown>;
          const kinds = Array.isArray(record.kinds)
            ? record.kinds.filter(
                (kind): kind is string => typeof kind === "string" && kind.length > 0,
              )
            : defaultQueryVaultConfig.kinds;
          return {
            thematicHint:
              typeof record.thematic_hint === "string"
                ? record.thematic_hint
                : defaultQueryVaultConfig.thematicHint,
            kinds: kinds.length > 0 ? kinds : defaultQueryVaultConfig.kinds,
            webSearch:
              typeof record.web_search === "boolean"
                ? record.web_search
                : defaultQueryVaultConfig.webSearch,
          } satisfies QueryVaultConfig;
        }),
        Effect.catchTag("StorageFileMissing", () => Effect.succeed(defaultQueryVaultConfig)),
      );

    const loadPrompt = (vaultId: Uuid, name: string) =>
      storage.readText(vaultOwner(vaultId), `prompts/${name}.md`).pipe(
        Effect.catchTag("StorageFileMissing", () =>
          Effect.tryPromise({
            try: () => readFile(promptUrl(name), "utf8"),
            catch: (error) => error,
          }),
        ),
        Effect.map((content) => content.trim()),
      );

    const documentForPath = (vaultId: Uuid, path: string) =>
      Effect.gen(function* () {
        if (path.startsWith("wiki/")) {
          const rows = yield* db.query((d) => d
            .select({ id: wikiArticles.id, title: wikiArticles.title })
            .from(wikiArticles)
            .where(and(eq(wikiArticles.vaultId, vaultId), eq(wikiArticles.filePath, path)))
            .limit(1));
          const row = first(rows);
          return { document_id: (row?.id as Uuid | undefined) ?? null, title: row?.title ?? null };
        }
        const rows = yield* db.query((d) => d
          .select({ id: sourceDocuments.id, title: sourceDocuments.title })
          .from(sourceDocuments)
          .where(and(eq(sourceDocuments.vaultId, vaultId), eq(sourceDocuments.filePath, path)))
          .limit(1));
        const row = first(rows);
        return { document_id: (row?.id as Uuid | undefined) ?? null, title: row?.title ?? null };
      });

    const buildIdentity = (vaultId: Uuid, label: string, vaultConfig: QueryVaultConfig) =>
      Effect.gen(function* () {
        const [wikiCountRows, rawCountRows] = yield* Effect.all(
          [
            db.query((d) => d
              .select({ count: sql<number>`count(*)::int` })
              .from(wikiArticles)
              .where(
                and(
                  eq(wikiArticles.vaultId, vaultId),
                  eq(wikiArticles.archived, false),
                  ne(wikiArticles.filePath, "wiki/_index.md"),
                ),
              )),
            db.query((d) => d
              .select({ count: sql<number>`count(*)::int` })
              .from(sourceDocuments)
              .where(eq(sourceDocuments.vaultId, vaultId))),
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
      Effect.gen(function* () {
        const result = yield* db.query((d) => d
          .execute(sql<{ tag: string }>`
            select distinct unnest(tags) as tag
            from source_documents
            where vault_id = ${vaultId}
            order by tag
          `));
        const rows = (result as unknown as { readonly rows: readonly { readonly tag: string }[] })
          .rows;
        return rows.map((row) => row.tag).filter((tag) => tag.length > 0);
      });

    const buildSystemPrompt = (
      vaultId: Uuid,
      label: string,
      vaultConfig: QueryVaultConfig,
      input: QueryRequest,
      webSearchEnabled: boolean,
    ) =>
      Effect.gen(function* () {
        const [identity, queryPrompt, btwPrompt] = yield* Effect.all(
          [
            buildIdentity(vaultId, label, vaultConfig),
            loadPrompt(vaultId, "query"),
            input.mode === "btw" ? loadPrompt(vaultId, "query_btw") : Effect.succeed(null),
          ],
          { concurrency: "unbounded" },
        );
        let prompt = retrievalCore.replace("{identity}", identity);
        prompt += "\n\n" + queryPrompt;
        if (webSearchEnabled) {
          prompt += "\n\n" + webSearchGuidance;
        }
        if (btwPrompt !== null) {
          prompt += "\n\n" + btwPrompt;
        }
        if (input.extra_instructions !== undefined) {
          prompt += "\n\n" + input.extra_instructions;
        }
        return prompt;
      });

    const sourceEvent = (
      context: QueryContext,
      name: string,
      args: Record<string, unknown>,
    ): Effect.Effect<QuerySourceData | undefined> =>
      Effect.gen(function* () {
        const source = pendingSourceEvent(name, args);
        if (source === undefined) return undefined;
        if (name === "read_document" || name === "expand_context") {
          const path = asStringArg(args, "path");
          if (path.startsWith("wiki/")) {
            context.trace.articlesRead.push(path);
          } else {
            context.trace.sourcesRead.push(path);
          }
        } else if (name === "search_content") {
          context.trace.searches.push(asStringArg(args, "query"));
        } else if (name === "web_search") {
          context.trace.searches.push(`web: ${asStringArg(args, "query")}`);
        } else if (name === "search_in_document") {
          const query = asStringArg(args, "query");
          const path = asStringArg(args, "path");
          context.trace.searches.push(`${query} · in ${path}`);
        }
        if (source.type === "article" || source.type === "raw") {
          return { ...source, ...(yield* documentForPath(context.vaultId, source.path)) };
        }
        if ("title" in source && source.path !== undefined) {
          return {
            ...source,
            title: (yield* documentForPath(context.vaultId, source.path)).title,
          };
        }
        return source;
      });

    const pendingSourceEvent = (
      name: string,
      args: Record<string, unknown>,
    ): QuerySourceData | undefined => {
      if (name === "read_document" || name === "expand_context") {
        const path = asStringArg(args, "path");
        const type = path.startsWith("wiki/") ? "article" : "raw";
        if (name === "expand_context") {
          return {
            type,
            document_id: null,
            path,
            title: null,
            start: asIntArg(args, "start"),
            end: asIntArg(args, "end"),
          };
        }
        return { type, document_id: null, path, title: null };
      }
      if (name === "search_content") {
        return { type: "search", query: asStringArg(args, "query"), scope: "kb", title: null };
      }
      if (name === "web_search") {
        return { type: "search", query: asStringArg(args, "query"), scope: "web", title: null };
      }
      if (name === "search_in_document") {
        return {
          type: "search",
          query: asStringArg(args, "query"),
          scope: "kb",
          path: asStringArg(args, "path"),
          title: null,
        };
      }
      if (name === "query_documents") {
        return { type: "query", filters: Object.fromEntries(truthyEntries(args)) };
      }
      if (name === "list_articles") {
        const filters = Object.fromEntries(
          ["contains", "sort"].flatMap((key) => {
            const value = args[key];
            return value ? [[key, value]] : [];
          }),
        );
        return { type: "query", filters };
      }
      if (name === "linked_articles") {
        return {
          type: "links",
          path: asStringArg(args, "path"),
          title: null,
        };
      }
      return undefined;
    };

    const sectionOutline = (vaultId: Uuid, path: string) =>
      Effect.gen(function* () {
        const chunks = yield* db.query((d) => d
          .select({
            chunkIndex: searchIndex.chunkIndex,
            heading: searchIndex.heading,
          })
          .from(searchIndex)
          .where(and(eq(searchIndex.vaultId, vaultId), eq(searchIndex.path, path)))
          .orderBy(asc(searchIndex.chunkIndex)));
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
      context: QueryContext,
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
          Effect.mapError(() => new ToolMiss(`Document not found: ${path}`)),
        );
        const source = emitSource
          ? yield* sourceEvent(context, "read_document", { path })
          : undefined;
        if (scope === "personal" || content.length <= readWholeLimit) {
          return {
            content: `# ${path} [${context.vaultLabel}]\n\n${content}`,
            source,
          };
        }
        const outline = yield* sectionOutline(context.vaultId, path);
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
          source,
        };
      });

    const searchRows = (vaultId: Uuid, query: string, path?: string) =>
      Effect.gen(function* () {
        if (query.trim().length === 0) {
          return [];
        }
        const armLimit = maxSearchResults * searchArmMultiplier;
        // OR-joined per-word tsquery matching the Python search repository:
        // strip non-word chars, drop words <= 2 chars, OR-join via plainto_tsquery.
        const words = query
          .replace(/[^\w\s]/g, "")
          .split(/\s+/)
          .filter((word) => word.length > 2);
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
        const embedded = yield* Effect.tryPromise({
          try: () => embeddings.embed([query]),
          catch: (error) => error,
        });
        const queryEmbedding = embedded[0];
        if (queryEmbedding === undefined) {
          return [];
        }
        const distance = sql<number>`${searchIndex.embedding} <=> ${vectorLiteral(queryEmbedding)}::vector`;
        const [bm25Rows, vectorRows] = yield* Effect.all(
          [
            db.query((d) => d
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
              .limit(armLimit)),
            db.query((d) => d
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
              .limit(armLimit)),
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
          .map(([key, score]) => {
            const row = metadata.get(key);
            if (row === undefined) {
              throw new Error(`missing search metadata for ${key}`);
            }
            return {
              ...row,
              body: row.body.length > 500 ? row.body.slice(0, 500) : row.body,
              score,
            };
          });
      });

    const searchContentTool = (context: QueryContext, query: string) =>
      Effect.gen(function* () {
        const results = yield* searchRows(context.vaultId, query);
        const source = yield* sourceEvent(context, "search_content", { query });
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

    const searchInDocumentTool = (context: QueryContext, path: string, query: string) =>
      Effect.gen(function* () {
        const results = yield* searchRows(context.vaultId, query, path);
        const source = yield* sourceEvent(context, "search_in_document", { path, query });
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
      context: QueryContext,
      path: string,
      rawStart: number,
      rawEnd: number,
    ) =>
      Effect.gen(function* () {
        let start = Math.trunc(rawStart);
        let end = Math.trunc(rawEnd);
        if (end < start) {
          [start, end] = [end, start];
        }
        end = Math.min(end, start + maxRangeChunks - 1);
        const chunks = yield* db.query((d) => d
          .select({
            chunkIndex: searchIndex.chunkIndex,
            heading: searchIndex.heading,
            body: searchIndex.body,
          })
          .from(searchIndex)
          .where(
            and(
              eq(searchIndex.vaultId, context.vaultId),
              eq(searchIndex.path, path),
              gte(searchIndex.chunkIndex, Math.max(0, start)),
              lte(searchIndex.chunkIndex, end),
            ),
          )
          .orderBy(asc(searchIndex.chunkIndex)));
        if (chunks.length === 0) {
          return yield* Effect.fail(
            new ToolMiss(
              `No indexed paragraphs at ${path} for chunks ${start}-${end}. Check the path and range against a search hit or document outline.`,
            ),
          );
        }
        const sections = chunks.map((chunk) => {
          const heading = chunk.heading.length > 0 ? `${chunk.heading}\n` : "";
          return `[chunk ${chunk.chunkIndex}]\n${heading}${chunk.body}`;
        });
        return {
          content:
            `# ${path} [${context.vaultLabel}] (chunks ${chunks[0].chunkIndex}–${chunks[chunks.length - 1].chunkIndex})\n\n` +
            sections.join("\n\n"),
          source: yield* sourceEvent(context, "expand_context", {
            path,
            start: rawStart,
            end: rawEnd,
          }),
        } satisfies ToolResult;
      });

    const linkedArticlesTool = (context: QueryContext, path: string) =>
      Effect.gen(function* () {
        if (!path.startsWith("wiki/")) {
          return yield* Effect.fail(
            new ToolMiss(
              `${path} is not a wiki article — the link graph only covers wiki articles. Use search_content to find related material.`,
            ),
          );
        }
        const sourceRows = yield* db.query((d) => d
          .select({ id: wikiArticles.id })
          .from(wikiArticles)
          .where(
            and(
              eq(wikiArticles.vaultId, context.vaultId),
              eq(wikiArticles.filePath, path),
              eq(wikiArticles.archived, false),
            ),
          )
          .limit(1));
        const source = first(sourceRows);
        if (source === undefined) {
          return yield* Effect.fail(new ToolMiss(`Article not found: ${path}`));
        }
        const outgoing = yield* db.query((d) => d
          .select({ filePath: wikiArticles.filePath, title: wikiArticles.title })
          .from(backlinks)
          .innerJoin(wikiArticles, eq(wikiArticles.id, backlinks.targetArticleId))
          .where(
            and(
              eq(backlinks.sourceArticleId, source.id),
              eq(wikiArticles.vaultId, context.vaultId),
              eq(wikiArticles.archived, false),
            ),
          )
          .orderBy(asc(sql`lower(${wikiArticles.title})`)));
        const incoming = yield* db.query((d) => d
          .select({ filePath: wikiArticles.filePath, title: wikiArticles.title })
          .from(backlinks)
          .innerJoin(wikiArticles, eq(wikiArticles.id, backlinks.sourceArticleId))
          .where(
            and(
              eq(backlinks.targetArticleId, source.id),
              eq(wikiArticles.vaultId, context.vaultId),
              eq(wikiArticles.archived, false),
            ),
          )
          .orderBy(asc(sql`lower(${wikiArticles.title})`)));
        const formatLinks = (
          rows: readonly { readonly title: string; readonly filePath: string }[],
        ) => rows.map((row) => `- [${row.title}](${row.filePath})`).join("\n") || "none";
        return {
          content:
            `# Links for ${path} [${context.vaultLabel}]\n\n` +
            `Outgoing (this article cites):\n${formatLinks(outgoing)}\n\n` +
            `Incoming (articles that cite this):\n${formatLinks(incoming)}`,
          source: yield* sourceEvent(context, "linked_articles", { path }),
        } satisfies ToolResult;
      });

    const queryDocumentsToolRun = (context: QueryContext, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const conditions: SQL[] = [eq(sourceDocuments.vaultId, context.vaultId)];
        const tags = Array.isArray(args.tags)
          ? args.tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0)
          : [];
        if (tags.length > 0) {
          conditions.push(
            sql`${sourceDocuments.tags} @> ARRAY[${sql.join(
              tags.map((tag) => sql`${tag}`),
              sql`, `,
            )}]::text[]`,
          );
        }
        if (typeof args.author === "string" && args.author.length > 0) {
          conditions.push(ilike(sourceDocuments.author, `%${args.author}%`));
        }
        if (typeof args.genre === "string" && args.genre.length > 0) {
          conditions.push(eq(sourceDocuments.genre, args.genre));
        }
        if (typeof args.date_gte === "string" && args.date_gte.length > 0) {
          conditions.push(gte(sourceDocuments.publishedDate, args.date_gte));
        }
        if (typeof args.date_lte === "string" && args.date_lte.length > 0) {
          conditions.push(lte(sourceDocuments.publishedDate, args.date_lte));
        }
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit)
            ? Math.max(1, Math.min(50, Math.trunc(args.limit)))
            : 20;
        const rows = yield* db.query((d) => d
          .select()
          .from(sourceDocuments)
          .where(and(...conditions))
          .orderBy(desc(sourceDocuments.updatedAt))
          .limit(limit));
        const source = yield* sourceEvent(context, "query_documents", args);
        if (rows.length === 0) {
          const filters = Object.fromEntries(
            Object.entries({
              tags: tags.length > 0 ? tags : undefined,
              author: args.author,
              genre: args.genre,
              date_gte: args.date_gte,
              date_lte: args.date_lte,
              limit,
            }).filter(([, value]) => Boolean(value)),
          );
          return {
            content: `No documents match the filters: ${JSON.stringify(filters)}`,
            source,
          } satisfies ToolResult;
        }
        const parts = rows.map((row) => {
          const lines = [`### ${row.title ?? row.filePath}`, `  [raw] ${row.filePath}`];
          if (row.author !== null) {
            lines[1] += ` by ${row.author}`;
          }
          if (row.publishedDate !== null) {
            lines[1] += ` (${row.publishedDate})`;
          }
          if (row.genre !== null) {
            lines.push(`  genre: ${row.genre}`);
          }
          if (row.tags.length > 0) {
            lines.push(`  tags: ${row.tags.join(", ")}`);
          }
          return lines.join("\n");
        });
        return {
          content: `Found ${rows.length} documents:\n\n${parts.join("\n\n")}`,
          source,
        } satisfies ToolResult;
      });

    const listArticlesToolRun = (context: QueryContext, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const contains =
          typeof args.contains === "string" && args.contains.length > 0 ? args.contains : undefined;
        const sort = args.sort ?? "central";
        if (sort !== "recent" && sort !== "alpha" && sort !== "central") {
          throw new Error(`Invalid list_articles sort: ${String(sort)}`);
        }
        const page =
          args.page === undefined || args.page === null ? 1 : Math.max(1, asIntArg(args, "page"));
        const conditions: SQL[] = [
          eq(wikiArticles.vaultId, context.vaultId),
          eq(wikiArticles.archived, false),
          ne(wikiArticles.filePath, "wiki/_index.md"),
        ];
        if (contains !== undefined) {
          const pattern = `%${contains}%`;
          conditions.push(
            or(ilike(wikiArticles.title, pattern), ilike(wikiArticles.precis, pattern)) as SQL,
          );
        }
        const countRows = yield* db.query((d) => d
          .select({ count: sql<number>`count(*)::int` })
          .from(wikiArticles)
          .where(and(...conditions)));
        const total = first(countRows)?.count ?? 0;
        const offset = (page - 1) * articlesPerPage;
        const inboundCount = sql<number>`count(${backlinks.sourceArticleId})`;
        const rows = yield* db.query((d) => {
          const query = d
            .select({
              filePath: wikiArticles.filePath,
              title: wikiArticles.title,
              precis: wikiArticles.precis,
              updatedAt: wikiArticles.updatedAt,
              inboundCount,
            })
            .from(wikiArticles)
            .leftJoin(backlinks, eq(backlinks.targetArticleId, wikiArticles.id))
            .where(and(...conditions))
            .groupBy(wikiArticles.id);
          const ordered =
            sort === "recent"
              ? query.orderBy(desc(wikiArticles.updatedAt))
              : sort === "alpha"
                ? query.orderBy(asc(sql`lower(${wikiArticles.title})`))
                : query.orderBy(desc(inboundCount), asc(sql`lower(${wikiArticles.title})`));
          return ordered.limit(articlesPerPage).offset(offset);
        });
        const source = yield* sourceEvent(context, "list_articles", args);
        if (rows.length === 0) {
          return {
            content:
              contains !== undefined
                ? `No article titles or precis contain '${contains}'. Try search_content for topical matches — it searches article bodies and raw sources too.`
                : "No wiki articles have been compiled yet.",
            source,
          } satisfies ToolResult;
        }
        const hi = offset + rows.length;
        const scope = contains === undefined ? "" : ` matching '${contains}'`;
        const lines = rows.map((row) => `- ${row.title} — ${row.filePath}\n  ${row.precis}`);
        const more =
          hi < total ? `\n\nMore available — call list_articles(page=${page + 1}) to continue.` : "";
        return {
          content:
            `Articles ${offset + 1}–${hi} of ${total}${scope} (by ${sort}):\n\n` +
            lines.join("\n") +
            more,
          source,
        } satisfies ToolResult;
      });

    const addUsageCost = (context: QueryContext, usage: { readonly cost?: number } | undefined) => {
      if (usage?.cost === undefined) {
        return false;
      }
      if (Number.isFinite(usage.cost) && usage.cost > 0) {
        context.costUsd += usage.cost;
      }
      return true;
    };

    const warnSafely = (event: string, fields: SafeLogFields) =>
      logger.warn(event, fields).pipe(Effect.catchCause(() => Effect.void));

    const errorSafely = (event: string, fields: SafeLogFields) =>
      logger.error(event, fields).pipe(Effect.catchCause(() => Effect.void));

    const addFallbackGenerationCosts = (context: QueryContext) =>
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
              isInterruptOnly(cause)
                ? Effect.interrupt
                : warnSafely("query.cost_lookup_failed", {
                    correlation_id: context.correlationId,
                    generation_id: generationId,
                    ...logErrorFields(causeError(cause)),
                  }),
            ),
          ),
        { discard: true },
      );

    const addGenerationCostFallback = (context: QueryContext, generationId: string | undefined) => {
      if (generationId !== undefined) {
        context.fallbackGenerationIds.push(generationId);
      }
    };

    const extractWebFacts = (
      context: QueryContext,
      query: string,
      results: readonly ParallelSearchResult[],
    ) =>
      Effect.gen(function* () {
        const numbered = results.map((result, index) => {
          const content = result.excerpts.join(" ");
          return `[${index + 1}] ${result.title}\n${result.url}\n${content}`;
        });
        const completion = yield* Effect.tryPromise({
          try: () =>
            languageModel.complete({
              model: appConfig.extractModel,
              temperature: 0,
              responseFormat: "json_object",
              messages: [
                { role: "system", content: webFactExtractionPrompt },
                {
                  role: "user",
                  content: `USER QUESTION: ${context.question}\n\nWEB RESULTS:\n\n${numbered.join("\n\n")}`,
                },
              ],
            }),
          catch: (error) => error,
        });
        addUsageCost(context, completion.usage);
        const parsed = JSON.parse(stripMarkdownJsonFence(completion.text)) as unknown;
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !Array.isArray((parsed as Record<string, unknown>).results)
        ) {
          return undefined;
        }
        const facts = new Map<number, readonly string[]>();
        for (const item of (parsed as { results: readonly unknown[] }).results) {
          if (typeof item !== "object" || item === null) {
            continue;
          }
          const record = item as Record<string, unknown>;
          if (typeof record.index !== "number" || !Array.isArray(record.facts)) {
            continue;
          }
          facts.set(
            record.index,
            record.facts.filter((fact): fact is string => typeof fact === "string"),
          );
        }
        return facts;
      }).pipe(
        Effect.catchCause((cause) =>
          isInterruptOnly(cause)
            ? Effect.interrupt
            : logger
                .warn("query.web_extract_failed", {
                  correlation_id: context.correlationId,
                  query,
                  ...logErrorFields(causeError(cause)),
                })
                .pipe(Effect.as(undefined)),
        ),
      );

    const webSearchToolRun = (context: QueryContext, query: string) =>
      Effect.gen(function* () {
        const source = yield* sourceEvent(context, "web_search", { query });
        return yield* Effect.gen(function* () {
          const results = yield* Effect.tryPromise({
            try: () => parallel.search({ question: context.question, query }),
            catch: (error) => error,
          });
          if (results.length === 0) {
            return { content: `No web results for '${query}'.`, source } satisfies ToolResult;
          }
          const facts = yield* extractWebFacts(context, query, results);
          if (facts === undefined) {
            return {
              content: `Web results for '${query}' could not be distilled to facts this call; rely on the knowledge base.`,
              source,
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
            source,
          } satisfies ToolResult;
        }).pipe(
          Effect.catchCause((cause) =>
            isInterruptOnly(cause)
              ? Effect.interrupt
              : logger
                  .warn("query.web_search_failed", {
                    correlation_id: context.correlationId,
                    query,
                    ...logErrorFields(causeError(cause)),
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
      context: QueryContext,
      name: string,
      args: Record<string, unknown>,
    ): Effect.Effect<ToolResult, unknown> => {
      switch (name) {
        case "read_document":
          return readDocumentTool(context, asStringArg(args, "path"), "vault");
        case "expand_context":
          return expandContextTool(
            context,
            asStringArg(args, "path"),
            asIntArg(args, "start"),
            asIntArg(args, "end"),
          );
        case "linked_articles":
          return linkedArticlesTool(context, asStringArg(args, "path"));
        case "search_content":
          return searchContentTool(context, asStringArg(args, "query"));
        case "search_in_document":
          return searchInDocumentTool(
            context,
            asStringArg(args, "path"),
            asStringArg(args, "query"),
          );
        case "query_documents":
          return queryDocumentsToolRun(context, args);
        case "list_articles":
          return listArticlesToolRun(context, args);
        case "web_search":
          return webSearchToolRun(context, asStringArg(args, "query"));
        default:
          return Effect.succeed({ content: `Unknown tool: ${name}` });
      }
    };

    const runModelRound = (
      context: QueryContext,
      model: string,
      messages: LlmMessage[],
      emit: (payload: QueryStreamPayload) => Effect.Effect<void>,
    ) =>
      Effect.gen(function* () {
        const state: ModelRoundState = {
          content: "",
          finishReason: null,
          toolCalls: new Map(),
        };
        yield* Stream.fromAsyncIterable(
          languageModel.streamChat({
            model,
            messages,
            tools: context.tools,
            temperature: 0.3,
          }),
          (error) => error,
        ).pipe(
          Stream.runForEach((part) => {
            if (part.type === "token") {
              state.content += part.text;
              return emit({ event: "token", data: { text: part.text } });
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

    const executeModelAttempt = (
      input: QueryExecutionState,
      emit: (payload: QueryStreamPayload) => Effect.Effect<void>,
    ): Effect.Effect<QueryModelAttemptResult, unknown> =>
      Effect.gen(function* () {
        const context = contextFromExecution(input);
        const model = input.models[input.modelIndex];
        if (model === undefined) {
          return {
            kind: "failed",
            state: input,
            error: sanitizedStreamError,
          } satisfies QueryModelAttemptResult;
        }
        const messages = cloneMessages(input.messages);
        context.selectedModel = model;
        context.trace.llmRounds += 1;
        yield* logger.info("query.stream_tool_round_start", {
          correlation_id: context.correlationId,
          model,
          round: context.trace.llmRounds,
        });
        return yield* Effect.gen(function* () {
          const roundState = yield* runModelRound(context, model, messages, emit);
          if (roundState.finishReason === "tool_calls" && roundState.toolCalls.size > 0) {
            const rawToolCalls = [...roundState.toolCalls.entries()]
              .sort(([left], [right]) => left - right)
              .map(([, toolCall]) => toolCall);
            const toolCalls: QueryPreparedToolCall[] = [];
            try {
              for (const toolCall of rawToolCalls) {
                const args = asObjectArgs(toolCall.arguments, toolCall.name);
                const pendingSource = pendingSourceEvent(toolCall.name, args);
                toolCalls.push({
                  ...toolCall,
                  args,
                  ...(pendingSource === undefined ? {} : { pendingSource }),
                });
              }
            } catch (error) {
              if (error instanceof MalformedToolArgs) {
                return {
                  kind: "failed",
                  state: executionState(
                    context,
                    messages,
                    input.models,
                    input.modelIndex,
                    input.startedAt,
                  ),
                  error: error.message,
                } satisfies QueryModelAttemptResult;
              }
              throw error;
            }
            messages.push({
              role: "assistant",
              content: roundState.content.length === 0 ? null : roundState.content,
              tool_calls: rawToolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "function",
                function: { name: toolCall.name, arguments: toolCall.arguments },
              })),
            });
            return {
              kind: "tool_calls",
              state: executionState(
                context,
                messages,
                input.models,
                input.modelIndex,
                input.startedAt,
              ),
              toolCalls,
            } satisfies QueryModelAttemptResult;
          }
          if (roundState.content.length > 0) {
            messages.push({ role: "assistant", content: roundState.content });
          }
          return {
            kind: "done",
            state: executionState(
              context,
              messages,
              input.models,
              input.modelIndex,
              input.startedAt,
            ),
          } satisfies QueryModelAttemptResult;
        }).pipe(
          Effect.catchCause((cause) => {
            if (isInterruptOnly(cause)) {
              return Effect.failCause(cause);
            }
            const error = causeError(cause);
            const nextState = executionState(
              context,
              messages,
              input.models,
              input.modelIndex,
              input.startedAt,
            );
            if (isRetryableModelError(error)) {
              return warnSafely("query.stream_retryable", {
                correlation_id: context.correlationId,
                model,
                ...logErrorFields(error),
              }).pipe(
                Effect.map((): QueryModelAttemptResult => {
                  const nextModelIndex = input.modelIndex + 1;
                  if (nextModelIndex < input.models.length) {
                    return {
                      kind: "retryable",
                      state: { ...nextState, modelIndex: nextModelIndex },
                    };
                  }
                  return { kind: "failed", state: nextState, error: sanitizedStreamError };
                }),
              );
            }
            return errorSafely("query.stream_failed", {
              correlation_id: context.correlationId,
              model,
              ...logErrorFields(error),
            }).pipe(
              Effect.as({
                kind: "failed",
                state: nextState,
                error: sanitizedStreamError,
              } satisfies QueryModelAttemptResult),
            );
          }),
        );
      });

    const executeTool = (input: QueryExecutionState, toolCall: QueryPreparedToolCall) =>
      Effect.gen(function* () {
        const context = contextFromExecution(input);
        const messages = cloneMessages(input.messages);
        context.trace.toolCalls += 1;
        const result = yield* dispatchTool(context, toolCall.name, toolCall.args).pipe(
          Effect.catchCause((cause) => {
            const error = causeError(cause);
            if (error instanceof ToolMiss) {
              return Effect.succeed<ToolResult>({ content: error.toolMessage });
            }
            if (isInterruptOnly(cause)) {
              return Effect.failCause(cause);
            }
            return errorSafely("query.stream_failed", {
              correlation_id: context.correlationId,
              model: context.selectedModel,
              ...logErrorFields(error),
            }).pipe(Effect.andThen(Effect.failCause(cause)));
          }),
        );
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result.content,
        });
        return {
          state: executionState(
            context,
            messages,
            input.models,
            input.modelIndex,
            input.startedAt,
          ),
          ...(result.source === undefined ? {} : { source: result.source }),
        } satisfies QueryToolExecutionResult;
      });

    const buildOriginMessages = (
      context: QueryContext,
      originPath: string,
      originScope: OriginScope,
    ) =>
      Effect.gen(function* () {
        const content = yield* readDocumentTool(context, originPath, originScope, false).pipe(
          Effect.map((result) => result.content),
          Effect.catch((error) =>
            error instanceof ToolMiss ? Effect.succeed(error.toolMessage) : Effect.fail(error),
          ),
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
      input: QueryRequest,
      correlationId: string,
      prechecked: QueryPrecheckedContext,
    ) =>
      Effect.gen(function* () {
        const vaultLabel = prechecked.vaultLabel;
        const [vaultConfig, tags] = yield* Effect.all(
          [loadVaultConfig(vaultId), distinctTags(vaultId)],
          { concurrency: "unbounded" },
        );
        const webSearchEnabled = vaultConfig.webSearch && parallel.hasApiKey;
        const tools = [
          ...baseTools,
          queryDocumentsTool(tags),
          ...(webSearchEnabled ? [webSearchTool] : []),
        ];
        const systemPrompt = yield* buildSystemPrompt(
          vaultId,
          vaultLabel,
          vaultConfig,
          input,
          webSearchEnabled,
        );
        const systemPromptHash = promptContentHash(systemPrompt);
        yield* recordPrompt(db, systemPromptHash, systemPrompt);
        const context: QueryContext = {
          userId,
          vaultId,
          question: input.question,
          vaultLabel,
          mode: input.mode,
          correlationId,
          tools,
          baseMessages: [],
          webSearchEnabled,
          trace: emptyTrace(),
          fallbackGenerationIds: [],
          systemPromptHash,
          costUsd: 0,
        };
        const messages: LlmMessage[] = [{ role: "system", content: systemPrompt }];
        if (
          input.origin_path !== undefined &&
          input.origin_path.length > 0
        ) {
          messages.push(
            ...(yield* buildOriginMessages(context, input.origin_path, input.origin_scope)),
          );
        }
        messages.push(
          ...input.history.map((message: HistoryMessage) => ({
            role: message.role,
            content: message.content,
          })),
        );
        messages.push({ role: "user", content: input.question });
        return {
          ...context,
          baseMessages: messages,
        } satisfies QueryContext;
      });

    const finalize = (
      context: QueryContext | undefined,
      startedAt: number,
      correlationId: string,
      userId: Uuid,
      vaultId: Uuid,
    ) =>
      Effect.gen(function* () {
        if (context !== undefined && context.costUsd > 0) {
          yield* db.query((d) => d
            .insert(llmCostEvents)
            .values({
              userId: context.userId,
              vaultId: context.vaultId,
              eventType: "query.stream",
              costUsd: context.costUsd.toFixed(6),
              correlationId: context.correlationId,
              model: context.selectedModel,
              promptHash: context.systemPromptHash,
            })
            .onConflictDoNothing())
            .pipe(
              Effect.catchCause((cause) =>
                isInterruptOnly(cause)
                  ? Effect.interrupt
                  : logger.error("query.cost_write_failed", {
                      correlation_id: context.correlationId,
                      ...logErrorFields(causeError(cause)),
                    }),
              ),
            );
        }
        yield* logger.info("query.stream_finalize", {
          correlation_id: context?.correlationId ?? correlationId,
          user_id: context?.userId ?? userId,
          vault_id: context?.vaultId ?? vaultId,
          mode: context?.mode,
          model: context?.selectedModel,
          web_search: context?.webSearchEnabled,
          articles_read: context?.trace.articlesRead.length ?? 0,
          sources_read: context?.trace.sourcesRead.length ?? 0,
          searches: context?.trace.searches.length ?? 0,
          llm_rounds: context?.trace.llmRounds ?? 0,
          tool_calls: context?.trace.toolCalls ?? 0,
          cost_usd: Number((context?.costUsd ?? 0).toFixed(6)),
          duration_ms: Date.now() - startedAt,
        });
      });

    const prepareExecution = (
      userId: Uuid,
      vaultId: Uuid,
      input: QueryRequest,
      prechecked: QueryPrecheckedContext,
    ): Effect.Effect<QueryExecutionState, unknown> =>
      Effect.gen(function* () {
        const startedAt = Date.now();
        const correlationId = `q-${randomUUID()}`;
        return yield* Effect.gen(function* () {
          const context = yield* setupContext(userId, vaultId, input, correlationId, prechecked);
          yield* logger.info("query.stream_start", {
            correlation_id: context.correlationId,
            user_id: userId,
            vault_id: vaultId,
            mode: context.mode,
            question_length: input.question.length,
            web_search: context.webSearchEnabled,
          });
          const requestedModel =
            input.model !== undefined && input.model.length > 0
              ? input.model
              : appConfig.queryModel;
          const models = [
            requestedModel,
            ...appConfig.queryFallbackModels.filter((model) => model !== requestedModel),
          ];
          return executionState(context, context.baseMessages, models, 0, startedAt);
        }).pipe(
          Effect.catchCause((cause) =>
            isInterruptOnly(cause)
              ? Effect.failCause(cause)
              : errorSafely("query.stream_setup_failed", {
                  correlation_id: correlationId,
                  vault_id: vaultId,
                  user_id: userId,
                  ...logErrorFields(causeError(cause)),
                }).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        );
      });

    return {
      prepareExecution,
      modelAttempt: executeModelAttempt,
      runTool: executeTool,
      finalizeExecution: (state) =>
        Effect.gen(function* () {
          const context = contextFromExecution(state);
          yield* addFallbackGenerationCosts(context);
          yield* finalize(
            context,
            state.startedAt,
            state.correlationId,
            state.userId,
            state.vaultId,
          );
        }).pipe(
          Effect.catchCause((cause) =>
            isInterruptOnly(cause)
              ? Effect.interrupt
              : errorSafely("query.stream_finalize_failed", {
                  correlation_id: state.correlationId,
                  vault_id: state.vaultId,
                  user_id: state.userId,
                  ...logErrorFields(causeError(cause)),
                }),
          ),
        ),
      draftHint: (_userId, description) =>
        Effect.gen(function* () {
          if (!languageModel.hasApiKey) {
            return yield* new ServiceUnavailable({
              detail: "LLM service not configured (OPENROUTER_API_KEY missing)",
            });
          }
          const trimmed = description.trim();
          if (trimmed.length === 0) {
            return yield* new BadRequest({ detail: "description required" });
          }
          const completion = yield* Effect.promise(() =>
            languageModel.complete({
              model: appConfig.queryModel,
              temperature: 0.4,
              messages: [
                { role: "system", content: draftHintSystem },
                { role: "user", content: trimmed },
              ],
            }),
          );
          return { thematic_hint: completion.text } satisfies DraftHintResponse;
        }),
    } satisfies QueryServiceShape;
  }),
);
