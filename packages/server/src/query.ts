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
  type QueryRequest,
  type QuerySseEvent,
  type QuerySourceData,
  type QueryStreamPayload,
  type Uuid,
} from "@great-minds/domain";
import { and, asc, desc, eq, gte, ilike, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer, Stream } from "effect";
import { parse as parseYaml } from "yaml";

import { AppConfig } from "./config.ts";
import { dieDatabase } from "./db-defects.ts";
import { EmbeddingsService } from "./embeddings.ts";
import { CostLookupService } from "./llm-costs.ts";
import {
  isRetryableModelError,
  LanguageModel,
  type LlmMessage,
  type LlmToolDefinition,
} from "./llm.ts";
import { StructuredLogger } from "./logging.ts";
import { ParallelSearchService, type ParallelSearchResult } from "./parallel.ts";
import { StorageFileMissing, VaultStorage } from "./storage.ts";

type QueryServiceShape = {
  readonly streamQuery: (
    userId: Uuid,
    vaultId: Uuid,
    input: QueryRequest,
    prechecked: QueryPrecheckedContext,
  ) => Stream.Stream<QuerySseEvent, never>;
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
  costUsd: number;
  selectedModel?: string;
};

type QueryPrecheckedContext = {
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

const sse = (payload: QueryStreamPayload): QuerySseEvent => ({
  event: payload.event,
  data: JSON.stringify(payload.data),
});

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
    const storage = yield* VaultStorage;
    const logger = yield* StructuredLogger;
    const languageModel = yield* LanguageModel;
    const embeddings = yield* EmbeddingsService;
    const costs = yield* CostLookupService;
    const parallel = yield* ParallelSearchService;
    const appConfig = yield* AppConfig;

    const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

    const loadVaultConfig = async (vaultId: Uuid) => {
      const content = await run(Effect.result(storage.readText(vaultId, configPath)));
      if (content._tag === "Failure") {
        if (content.failure instanceof StorageFileMissing) {
          return defaultQueryVaultConfig;
        }
        throw content.failure;
      }
      const parsed = parseYaml(content.success) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return defaultQueryVaultConfig;
      }
      const record = parsed as Record<string, unknown>;
      const kinds = Array.isArray(record.kinds)
        ? record.kinds.filter((kind): kind is string => typeof kind === "string" && kind.length > 0)
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
    };

    const loadPrompt = async (vaultId: Uuid, name: string) => {
      const override = await run(Effect.result(storage.readText(vaultId, `prompts/${name}.md`)));
      if (override._tag === "Success") {
        return override.success.trim();
      }
      if (!(override.failure instanceof StorageFileMissing)) {
        throw override.failure;
      }
      return (await readFile(promptUrl(name), "utf8")).trim();
    };

    const titleForPath = async (vaultId: Uuid, path: string) => {
      if (path.startsWith("wiki/")) {
        const rows = await run(
          db
            .select({ title: wikiArticles.title })
            .from(wikiArticles)
            .where(and(eq(wikiArticles.vaultId, vaultId), eq(wikiArticles.filePath, path)))
            .limit(1)
            .pipe(dieDatabase),
        );
        return first(rows)?.title ?? null;
      }
      const rows = await run(
        db
          .select({ title: sourceDocuments.title })
          .from(sourceDocuments)
          .where(and(eq(sourceDocuments.vaultId, vaultId), eq(sourceDocuments.filePath, path)))
          .limit(1)
          .pipe(dieDatabase),
      );
      return first(rows)?.title ?? null;
    };

    const buildIdentity = async (vaultId: Uuid, label: string, vaultConfig: QueryVaultConfig) => {
      const wikiCountRows = await run(
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(wikiArticles)
          .where(
            and(
              eq(wikiArticles.vaultId, vaultId),
              eq(wikiArticles.archived, false),
              ne(wikiArticles.filePath, "wiki/_index.md"),
            ),
          )
          .pipe(dieDatabase),
      );
      const rawCountRows = await run(
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(sourceDocuments)
          .where(eq(sourceDocuments.vaultId, vaultId))
          .pipe(dieDatabase),
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
    };

    const distinctTags = async (vaultId: Uuid) => {
      const result = await run(
        db
          .execute(sql<{ tag: string }>`
            select distinct unnest(tags) as tag
            from source_documents
            where vault_id = ${vaultId}
            order by tag
          `)
          .pipe(dieDatabase),
      );
      const rows = (result as unknown as { readonly rows: readonly { readonly tag: string }[] })
        .rows;
      return rows.map((row) => row.tag).filter((tag) => tag.length > 0);
    };

    const buildSystemPrompt = async (
      vaultId: Uuid,
      label: string,
      vaultConfig: QueryVaultConfig,
      input: QueryRequest,
      webSearchEnabled: boolean,
    ) => {
      const identity = await buildIdentity(vaultId, label, vaultConfig);
      let prompt = retrievalCore.replace("{identity}", identity);
      prompt += "\n\n" + (await loadPrompt(vaultId, "query"));
      if (webSearchEnabled) {
        prompt += "\n\n" + webSearchGuidance;
      }
      if (input.mode === "btw") {
        prompt += "\n\n" + (await loadPrompt(vaultId, "query_btw"));
      }
      if (input.extra_instructions !== undefined && input.extra_instructions !== null) {
        prompt += "\n\n" + input.extra_instructions;
      }
      return prompt;
    };

    const sourceEvent = async (
      context: QueryContext,
      name: string,
      args: Record<string, unknown>,
    ): Promise<QuerySourceData | undefined> => {
      if (name === "read_document" || name === "expand_context") {
        const path = asStringArg(args, "path");
        const type = path.startsWith("wiki/") ? "article" : "raw";
        const title = await titleForPath(context.vaultId, path);
        if (type === "article") {
          context.trace.articlesRead.push(path);
        } else {
          context.trace.sourcesRead.push(path);
        }
        if (name === "expand_context") {
          return {
            type,
            path,
            title,
            start: asIntArg(args, "start"),
            end: asIntArg(args, "end"),
          };
        }
        return { type, path, title };
      }
      if (name === "search_content") {
        const query = asStringArg(args, "query");
        context.trace.searches.push(query);
        return { type: "search", query };
      }
      if (name === "web_search") {
        const query = `web: ${asStringArg(args, "query")}`;
        context.trace.searches.push(query);
        return { type: "search", query };
      }
      if (name === "search_in_document") {
        const query = `${asStringArg(args, "query")} · in ${asStringArg(args, "path")}`;
        context.trace.searches.push(query);
        return { type: "search", query };
      }
      if (name === "query_documents") {
        const filters = Object.fromEntries(truthyEntries(args));
        return { type: "query", filters };
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
        const path = asStringArg(args, "path");
        return { type: "links", path, title: await titleForPath(context.vaultId, path) };
      }
      return undefined;
    };

    const sectionOutline = async (vaultId: Uuid, path: string) => {
      const chunks = await run(
        db
          .select({
            chunkIndex: searchIndex.chunkIndex,
            heading: searchIndex.heading,
          })
          .from(searchIndex)
          .where(and(eq(searchIndex.vaultId, vaultId), eq(searchIndex.path, path)))
          .orderBy(asc(searchIndex.chunkIndex))
          .pipe(dieDatabase),
      );
      const sections: { start: number; end: number; heading: string }[] = [];
      for (const chunk of chunks) {
        const last = sections[sections.length - 1];
        if (
          last === undefined ||
          last.heading !== chunk.heading ||
          last.end !== chunk.chunkIndex - 1
        ) {
          sections.push({ start: chunk.chunkIndex, end: chunk.chunkIndex, heading: chunk.heading });
        } else {
          last.end = chunk.chunkIndex;
        }
      }
      return sections;
    };

    const readDocumentTool = async (
      context: QueryContext,
      path: string,
      emitSource = true,
    ): Promise<ToolResult> => {
      const content = await run(Effect.result(storage.readText(context.vaultId, path)));
      if (content._tag === "Failure") {
        throw new ToolMiss(`Document not found: ${path}`);
      }
      const source = emitSource ? await sourceEvent(context, "read_document", { path }) : undefined;
      if (content.success.length <= readWholeLimit) {
        return {
          content: `# ${path} [${context.vaultLabel}]\n\n${content.success}`,
          source,
        };
      }
      const outline = await sectionOutline(context.vaultId, path);
      const lines = outline.map(
        (section) =>
          `- chunks ${section.start}-${section.end}: ${section.heading || "(no heading)"}`,
      );
      return {
        content:
          `# ${path} [${context.vaultLabel}]\n\n` +
          `This document is large (${content.success.length.toLocaleString("en-US")} chars) — do NOT read it from the top. To find the passages relevant to your question, call search_in_document(path, query). Use expand_context(path, start, end) only on a range a search hit or a specific section below points to.\n\n` +
          "Section outline (a map, not the text):\n\n" +
          lines.join("\n"),
        source,
      };
    };

    const searchRows = async (vaultId: Uuid, query: string, path?: string) => {
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
      const queryEmbedding = (await embeddings.embed([query]))[0];
      if (queryEmbedding === undefined) {
        return [];
      }
      const distance = sql<number>`${searchIndex.embedding} <=> ${vectorLiteral(queryEmbedding)}::vector`;
      const [bm25Rows, vectorRows] = await Promise.all([
        run(
          db
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
            .limit(armLimit)
            .pipe(dieDatabase),
        ),
        run(
          db
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
            .limit(armLimit)
            .pipe(dieDatabase),
        ),
      ]);
      type SearchRow = (typeof bm25Rows)[number];
      type SearchKey = `${string}:${string}:${number}`;
      const scores = new Map<SearchKey, number>();
      const metadata = new Map<SearchKey, SearchRow>();
      const vectorRanks = new Map<SearchKey, number>();
      const bm25Ranks = new Map<SearchKey, number>();
      const keyFor = (row: SearchRow): SearchKey =>
        `${row.vaultId}:${row.path}:${row.chunkIndex}`;
      const addRows = (
        rows: readonly SearchRow[],
        ranks: Map<SearchKey, number>,
      ) => {
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
    };

    const searchContentTool = async (context: QueryContext, query: string): Promise<ToolResult> => {
      const results = await searchRows(context.vaultId, query);
      const source = await sourceEvent(context, "search_content", { query });
      if (results.length === 0) {
        return { content: `No results found for: ${query}`, source };
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
      };
    };

    const searchInDocumentTool = async (
      context: QueryContext,
      path: string,
      query: string,
    ): Promise<ToolResult> => {
      const results = await searchRows(context.vaultId, query, path);
      const source = await sourceEvent(context, "search_in_document", { path, query });
      if (results.length === 0) {
        return {
          content: `No passages in ${path} match '${query}'. Check the path (from list_articles or a search_content hit), or use search_content to search the whole knowledge base.`,
          source,
        };
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
      };
    };

    const expandContextTool = async (
      context: QueryContext,
      path: string,
      rawStart: number,
      rawEnd: number,
    ): Promise<ToolResult> => {
      let start = Math.trunc(rawStart);
      let end = Math.trunc(rawEnd);
      if (end < start) {
        [start, end] = [end, start];
      }
      end = Math.min(end, start + maxRangeChunks - 1);
      const chunks = await run(
        db
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
          .orderBy(asc(searchIndex.chunkIndex))
          .pipe(dieDatabase),
      );
      if (chunks.length === 0) {
        throw new ToolMiss(
          `No indexed paragraphs at ${path} for chunks ${start}-${end}. Check the path and range against a search hit or document outline.`,
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
        source: await sourceEvent(context, "expand_context", {
          path,
          start: rawStart,
          end: rawEnd,
        }),
      };
    };

    const linkedArticlesTool = async (context: QueryContext, path: string): Promise<ToolResult> => {
      if (!path.startsWith("wiki/")) {
        throw new ToolMiss(
          `${path} is not a wiki article — the link graph only covers wiki articles. Use search_content to find related material.`,
        );
      }
      const sourceRows = await run(
        db
          .select({ id: wikiArticles.id })
          .from(wikiArticles)
          .where(
            and(
              eq(wikiArticles.vaultId, context.vaultId),
              eq(wikiArticles.filePath, path),
              eq(wikiArticles.archived, false),
            ),
          )
          .limit(1)
          .pipe(dieDatabase),
      );
      const source = first(sourceRows);
      if (source === undefined) {
        throw new ToolMiss(`Article not found: ${path}`);
      }
      const outgoing = await run(
        db
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
          .orderBy(asc(sql`lower(${wikiArticles.title})`))
          .pipe(dieDatabase),
      );
      const incoming = await run(
        db
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
          .orderBy(asc(sql`lower(${wikiArticles.title})`))
          .pipe(dieDatabase),
      );
      const formatLinks = (
        rows: readonly { readonly title: string; readonly filePath: string }[],
      ) => rows.map((row) => `- [${row.title}](${row.filePath})`).join("\n") || "none";
      return {
        content:
          `# Links for ${path} [${context.vaultLabel}]\n\n` +
          `Outgoing (this article cites):\n${formatLinks(outgoing)}\n\n` +
          `Incoming (articles that cite this):\n${formatLinks(incoming)}`,
        source: await sourceEvent(context, "linked_articles", { path }),
      };
    };

    const queryDocumentsToolRun = async (
      context: QueryContext,
      args: Record<string, unknown>,
    ): Promise<ToolResult> => {
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
      const rows = await run(
        db
          .select()
          .from(sourceDocuments)
          .where(and(...conditions))
          .orderBy(desc(sourceDocuments.updatedAt))
          .limit(limit)
          .pipe(dieDatabase),
      );
      const source = await sourceEvent(context, "query_documents", args);
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
        return { content: `No documents match the filters: ${JSON.stringify(filters)}`, source };
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
      return { content: `Found ${rows.length} documents:\n\n${parts.join("\n\n")}`, source };
    };

    const listArticlesToolRun = async (
      context: QueryContext,
      args: Record<string, unknown>,
    ): Promise<ToolResult> => {
      const contains =
        typeof args.contains === "string" && args.contains.length > 0 ? args.contains : undefined;
      const sort = args.sort ?? "central";
      if (sort !== "recent" && sort !== "alpha" && sort !== "central") {
        throw new Error(`Invalid list_articles sort: ${String(sort)}`);
      }
      const page = args.page === undefined || args.page === null ? 1 : Math.max(1, asIntArg(args, "page"));
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
      const countRows = await run(
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(wikiArticles)
          .where(and(...conditions))
          .pipe(dieDatabase),
      );
      const total = first(countRows)?.count ?? 0;
      const offset = (page - 1) * articlesPerPage;
      const inboundCount = sql<number>`count(${backlinks.sourceArticleId})`;
      const query = db
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
      const rows = await run(ordered.limit(articlesPerPage).offset(offset).pipe(dieDatabase));
      const source = await sourceEvent(context, "list_articles", args);
      if (rows.length === 0) {
        return {
          content:
            contains !== undefined
              ? `No article titles or precis contain '${contains}'. Try search_content for topical matches — it searches article bodies and raw sources too.`
              : "No wiki articles have been compiled yet.",
          source,
        };
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
      };
    };

    const addUsageCost = (
      context: QueryContext,
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

    const warnSafely = async (event: string, fields: SafeLogFields) => {
      try {
        await run(logger.warn(event, fields));
      } catch {
        // Logging must never turn a handled stream condition into a stream failure event.
      }
    };

    const errorSafely = async (event: string, fields: SafeLogFields) => {
      try {
        await run(logger.error(event, fields));
      } catch {
        // Logging must never turn a handled stream condition into a stream failure event.
      }
    };

    const addFallbackGenerationCosts = async (context: QueryContext) => {
      for (const generationId of context.fallbackGenerationIds) {
        try {
          const cost = await costs.lookupGenerationCost(generationId);
          if (cost !== null && Number.isFinite(cost) && cost > 0) {
            context.costUsd += cost;
          }
        } catch (error) {
          await warnSafely("query.cost_lookup_failed", {
            correlation_id: context.correlationId,
            generation_id: generationId,
            ...logErrorFields(error),
          });
        }
      }
    };

    const addGenerationCostFallback = (context: QueryContext, generationId: string | undefined) => {
      if (generationId !== undefined) {
        context.fallbackGenerationIds.push(generationId);
      }
    };

    const addCompletionCost = (context: QueryContext, usage: { readonly cost?: number } | undefined) => {
      addUsageCost(context, usage);
    };

    const extractWebFacts = async (
      context: QueryContext,
      query: string,
      results: readonly ParallelSearchResult[],
    ) => {
      const numbered = results.map((result, index) => {
        const content = result.excerpts.join(" ");
        return `[${index + 1}] ${result.title}\n${result.url}\n${content}`;
      });
      try {
        const completion = await languageModel.complete({
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
        });
        addCompletionCost(context, completion.usage);
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
      } catch (error) {
        await run(
          logger.warn("query.web_extract_failed", {
            correlation_id: context.correlationId,
            query,
            ...logErrorFields(error),
          }),
        );
        return undefined;
      }
    };

    const webSearchToolRun = async (context: QueryContext, query: string): Promise<ToolResult> => {
      const source = await sourceEvent(context, "web_search", { query });
      try {
        const results = await parallel.search({ question: context.question, query });
        if (results.length === 0) {
          return { content: `No web results for '${query}'.`, source };
        }
        const facts = await extractWebFacts(context, query, results);
        if (facts === undefined) {
          return {
            content: `Web results for '${query}' could not be distilled to facts this call; rely on the knowledge base.`,
            source,
          };
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
        };
      } catch (error) {
        await run(
          logger.warn("query.web_search_failed", {
            correlation_id: context.correlationId,
            query,
            ...logErrorFields(error),
          }),
        );
        return {
          content: `Web search failed for '${query}'. Rely on the knowledge base or rephrase.`,
          source,
        };
      }
    };

    const dispatchTool = async (
      context: QueryContext,
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolResult> => {
      switch (name) {
        case "read_document":
          return await readDocumentTool(context, asStringArg(args, "path"));
        case "expand_context":
          return await expandContextTool(
            context,
            asStringArg(args, "path"),
            asIntArg(args, "start"),
            asIntArg(args, "end"),
          );
        case "linked_articles":
          return await linkedArticlesTool(context, asStringArg(args, "path"));
        case "search_content":
          return await searchContentTool(context, asStringArg(args, "query"));
        case "search_in_document":
          return await searchInDocumentTool(
            context,
            asStringArg(args, "path"),
            asStringArg(args, "query"),
          );
        case "query_documents":
          return await queryDocumentsToolRun(context, args);
        case "list_articles":
          return await listArticlesToolRun(context, args);
        case "web_search":
          return await webSearchToolRun(context, asStringArg(args, "query"));
        default:
          return { content: `Unknown tool: ${name}` };
      }
    };

    async function* runModelRound(
      context: QueryContext,
      model: string,
      messages: LlmMessage[],
    ): AsyncGenerator<QuerySseEvent, ModelRoundState, void> {
      const state: ModelRoundState = {
        content: "",
        finishReason: null,
        toolCalls: new Map(),
      };
      for await (const part of languageModel.streamChat({
        model,
        messages,
        tools: context.tools,
        temperature: 0.3,
      })) {
        if (part.type === "token") {
          state.content += part.text;
          yield sse({ event: "token", data: { text: part.text } });
          continue;
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
          continue;
        }
        state.finishReason = part.finishReason;
        if (!addUsageCost(context, part.usage)) {
          addGenerationCostFallback(context, part.generationId);
        }
      }
      return state;
    }

    async function* streamChatLoop(context: QueryContext, model: string, messages: LlmMessage[]) {
      while (true) {
        context.trace.llmRounds += 1;
        await run(
          logger.info("query.stream_tool_round_start", {
            correlation_id: context.correlationId,
            model,
            round: context.trace.llmRounds,
          }),
        );
        const round = runModelRound(context, model, messages);
        let state: ModelRoundState | undefined;
        while (true) {
          const next = await round.next();
          if (next.done === true) {
            state = next.value;
            break;
          }
          yield next.value;
        }
        if (state.finishReason === "tool_calls" && state.toolCalls.size > 0) {
          const toolCalls = [...state.toolCalls.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, toolCall]) => toolCall);
          messages.push({
            role: "assistant",
            content: state.content.length === 0 ? null : state.content,
            tool_calls: toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: "function",
              function: { name: toolCall.name, arguments: toolCall.arguments },
            })),
          });
          for (const toolCall of toolCalls) {
            context.trace.toolCalls += 1;
            let args: Record<string, unknown>;
            try {
              args = asObjectArgs(toolCall.arguments, toolCall.name);
            } catch (error) {
              if (error instanceof MalformedToolArgs) {
                yield sse({ event: "error", data: { message: error.message } });
                return;
              }
              throw error;
            }
            let result: ToolResult;
            try {
              result = await dispatchTool(context, toolCall.name, args);
            } catch (error) {
              if (error instanceof ToolMiss) {
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: error.toolMessage,
                });
                continue;
              }
              throw error;
            }
            if (result.source !== undefined) {
              yield sse({ event: "source", data: result.source });
            }
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: result.content,
            });
          }
          continue;
        }
        if (state.content.length > 0) {
          messages.push({ role: "assistant", content: state.content });
        }
        yield sse({ event: "done", data: {} });
        return;
      }
    }

    const buildOriginMessages = async (context: QueryContext, originPath: string) => {
      let content: string;
      try {
        content = (await readDocumentTool(context, originPath, false)).content;
      } catch (error) {
        if (error instanceof ToolMiss) {
          content = error.toolMessage;
        } else {
          throw error;
        }
      }
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
    };

    const setupContext = async (
      userId: Uuid,
      vaultId: Uuid,
      input: QueryRequest,
      correlationId: string,
      prechecked: QueryPrecheckedContext,
    ) => {
      const vaultLabel = prechecked.vaultLabel;
      const vaultConfig = await loadVaultConfig(vaultId);
      const webSearchEnabled = vaultConfig.webSearch && parallel.hasApiKey;
      const tags = await distinctTags(vaultId);
      const tools = [
        ...baseTools,
        queryDocumentsTool(tags),
        ...(webSearchEnabled ? [webSearchTool] : []),
      ];
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
        costUsd: 0,
      };
      const systemPrompt = await buildSystemPrompt(
        vaultId,
        vaultLabel,
        vaultConfig,
        input,
        webSearchEnabled,
      );
      const messages: LlmMessage[] = [{ role: "system", content: systemPrompt }];
      if (
        input.origin_path !== undefined &&
        input.origin_path !== null &&
        input.origin_path.length > 0
      ) {
        messages.push(...(await buildOriginMessages(context, input.origin_path)));
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
    };

    const finalize = async (
      context: QueryContext | undefined,
      startedAt: number,
      correlationId: string,
      userId: Uuid,
      vaultId: Uuid,
    ) => {
      if (context !== undefined && context.costUsd > 0) {
        try {
          await run(
            db
              .insert(llmCostEvents)
              .values({
                userId: context.userId,
                vaultId: context.vaultId,
                eventType: "query.stream",
                costUsd: context.costUsd.toFixed(6),
                correlationId: context.correlationId,
              })
              .pipe(dieDatabase),
          );
        } catch (error) {
          await run(
            logger.error("query.cost_write_failed", {
              correlation_id: context.correlationId,
              ...logErrorFields(error),
            }),
          );
        }
      }
      await run(
        logger.info("query.stream_finalize", {
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
        }),
      );
    };

    async function* runQueryStream(
      userId: Uuid,
      vaultId: Uuid,
      input: QueryRequest,
      prechecked: QueryPrecheckedContext,
    ) {
      const startedAt = Date.now();
      const correlationId = `q-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      let context: QueryContext | undefined;
      try {
        context = await setupContext(userId, vaultId, input, correlationId, prechecked);
        await run(
          logger.info("query.stream_start", {
            correlation_id: context.correlationId,
            user_id: userId,
            vault_id: vaultId,
            mode: context.mode,
            question_length: input.question.length,
            web_search: context.webSearchEnabled,
          }),
        );
        const requestedModel =
          input.model !== undefined && input.model !== null && input.model.length > 0
            ? input.model
            : appConfig.queryModel;
        const fallbackModels = [
          requestedModel,
          ...appConfig.queryFallbackModels.filter((model) => model !== requestedModel),
        ];
        for (const model of fallbackModels) {
          const messages = cloneMessages(context.baseMessages);
          try {
            context.selectedModel = model;
            let emittedDone = false;
            for await (const event of streamChatLoop(context, model, messages)) {
              yield event;
              emittedDone ||= event.event === "done";
            }
            if (emittedDone) {
              await addFallbackGenerationCosts(context);
            }
            return;
          } catch (error) {
            if (isRetryableModelError(error)) {
              await warnSafely("query.stream_retryable", {
                correlation_id: context.correlationId,
                model,
                ...logErrorFields(error),
              });
              continue;
            }
            await errorSafely("query.stream_failed", {
              correlation_id: context.correlationId,
              model,
              ...logErrorFields(error),
            });
            yield sse({ event: "error", data: { message: sanitizedStreamError } });
            return;
          }
        }
        yield sse({ event: "error", data: { message: sanitizedStreamError } });
      } catch (error) {
        await errorSafely("query.stream_setup_failed", {
          correlation_id: context?.correlationId ?? correlationId,
          vault_id: vaultId,
          user_id: userId,
          ...logErrorFields(error),
        });
        yield sse({ event: "error", data: { message: sanitizedStreamError } });
      } finally {
        try {
          await finalize(context, startedAt, correlationId, userId, vaultId);
        } catch (error) {
          await errorSafely("query.stream_finalize_failed", {
            correlation_id: context?.correlationId ?? correlationId,
            vault_id: vaultId,
            user_id: userId,
            ...logErrorFields(error),
          });
        }
      }
    }

    return {
      streamQuery: (userId, vaultId, input, prechecked) =>
        Stream.fromAsyncIterable(
          runQueryStream(userId, vaultId, input, prechecked),
          () => undefined as never,
        ) as Stream.Stream<QuerySseEvent, never>,
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
