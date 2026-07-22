import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  authCodes,
  backlinks,
  Database,
  llmCostEvents,
  searchIndex,
  sourceDocuments,
  topics,
  users,
  vaultMemberships,
  vaults,
  wikiArticles,
} from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { sql } from "drizzle-orm";
import { Effect, Layer, Option, Redacted } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { makeAppLayer } from "../src/app-layer.ts";
import { ClockService, makeTestClock } from "../src/clock.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { StructuredLogger, StructuredLoggerLive } from "../src/logging.ts";
import { makeTestMailer } from "../src/mailer.ts";
import { startServer } from "../src/server.ts";
import { TokenService } from "../src/tokens.ts";
import {
  finishPart,
  makeEmbeddings,
  makeCostLookup,
  makeDisabledParallelSearch,
  makeParallelSearch,
  makeScriptedLanguageModel,
  malformedToolCallPart,
  retryableModelError,
  tokenPart,
  toolCallPart,
} from "./query-stubs.ts";

const initialTime = new Date("2026-07-10T12:00:00.000Z");

const id = {
  alice: "00000000-0000-4000-8000-000000020001",
  bob: "00000000-0000-4000-8000-000000020002",
  vault: "00000000-0000-4000-8000-000000020101",
  topicAlpha: "00000000-0000-4000-8000-000000020301",
  topicBeta: "00000000-0000-4000-8000-000000020302",
  articleAlpha: "00000000-0000-4000-8000-000000020401",
  articleBeta: "00000000-0000-4000-8000-000000020402",
  source: "00000000-0000-4000-8000-000000020501",
} as const;

type TestServices = AppConfig | Database | ClockService | StructuredLogger | TokenService;

type TestState = {
  readonly started: Awaited<ReturnType<typeof startServer>>;
  readonly storageRoot: string;
  readonly token: string;
};

type HarnessOptions = {
  readonly language: ReturnType<typeof makeScriptedLanguageModel>;
  readonly embeddings?: ReturnType<typeof makeEmbeddings>;
  readonly costs?: ReturnType<typeof makeCostLookup>;
  readonly parallel?: ReturnType<typeof makeParallelSearch>;
  readonly parallelLayer?: ReturnType<typeof makeDisabledParallelSearch>;
  readonly configOverrides?: Partial<
    Pick<AppConfigShape, "openRouterApiKey" | "queryModel" | "queryFallbackModels">
  >;
};

let state: TestState | undefined;

const currentState = () => {
  if (state === undefined) {
    throw new Error("test state is not initialized");
  }
  return state;
};

const databaseUrl = () => {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
  return value;
};

const testConfig = (
  url: string,
  dataDir: string,
  overrides: Partial<
    Pick<AppConfigShape, "openRouterApiKey" | "queryModel" | "queryFallbackModels">
  > = {},
): AppConfigShape => ({
  databaseUrl: Redacted.make(url),
  jwtSecret: Redacted.make("integration-test-jwt-secret"),
  jwtAccessExpiryMinutes: 30,
  jwtRefreshExpiryDays: 7,
  authCodeExpiryMinutes: 10,
  resendApiKey: Option.none(),
  resendFromEmail: Option.none(),
  dataDir,
  storageBackend: "local",
  r2AccountId: Option.none(),
  r2AccessKeyId: Option.none(),
  r2SecretAccessKey: Option.none(),
  r2BucketPrefix: "gm-test",
  openRouterApiKey: overrides.openRouterApiKey ?? Option.some(Redacted.make("test-openrouter-key")),
  openRouterApiUrl: "https://openrouter.ai/api/v1",
  parallelApiKey: Option.some(Redacted.make("test-parallel-key")),
  parallelSearchUrl: "https://api.parallel.ai/v1beta/search",
  queryModel: overrides.queryModel ?? "primary/test-model",
  queryFallbackModels: overrides.queryFallbackModels ?? ["fallback/test-model"],
  extractModel: "extract/test-model",
  mapModel: "map/test-model",
  reduceModel: "reduce/test-model",
  renderModel: "render/test-model",
  compileEnrichConcurrency: 1,
  compileWriteConcurrency: 1,
  compilePartitionTargetTokens: 100_000,
  compilePartitionMinFactor: 0.3,
  compilePartitionMaxFactor: 1.5,
  compilePremergeJaccardThreshold: 0.8,
  compileDeriveRelatedLimit: 20,
  pipelineConcurrency: 1,
  goldensRandomSeed: Option.none(),
  goldensClock: Option.none(),
  embeddingModel: "embedding/test-model",
  corsOrigins: ["http://localhost:5173"],
  suppressAuth: false,
  serverHost: "127.0.0.1",
  serverPort: 0,
});

const runDb = <A>(effect: Effect.Effect<A, unknown, TestServices>) =>
  currentState().started.runtime.runPromise(effect);

const resetDatabase = () =>
  runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.delete(authCodes).pipe(Effect.orDie);
      yield* db.delete(users).pipe(Effect.orDie);
    }),
  );

const writeVaultFile = async (vaultId: string, path: string, content: string) => {
  const fullPath = join(currentState().storageRoot, "vaults", vaultId, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
};

const issueToken = (userId: string) =>
  runDb(
    Effect.gen(function* () {
      const tokens = yield* TokenService;
      return yield* tokens.issueAccessToken(userId as Uuid, initialTime);
    }),
  );

const insertUser = (userId: string, email: string) =>
  runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db
        .insert(users)
        .values({ id: userId, email, createdAt: initialTime })
        .pipe(Effect.orDie);
    }),
  );

const startHarness = async (options: HarnessOptions) => {
  const clock = makeTestClock(initialTime);
  const storageRoot = await mkdtemp(join(tmpdir(), "great-minds-query-storage-"));
  const configLayer = Layer.succeed(
    AppConfig,
    testConfig(databaseUrl(), storageRoot, options.configOverrides),
  );
  const costs = options.costs ?? makeCostLookup(new Map());
  const embeddings =
    options.embeddings ??
    makeEmbeddings(
      new Map([
        ["capital", vector1024([1, 0, 0])],
        ["value", vector1024([1, 0, 0])],
      ]),
    );
  const appLayer = makeAppLayer({
    config: configLayer,
    clock: clock.layer,
    mailer: makeTestMailer().layer,
    logger: StructuredLoggerLive,
    languageModel: options.language.layer,
    embeddings: embeddings.layer,
    costLookup: costs.layer,
    parallelSearch:
      options.parallel?.layer ?? options.parallelLayer ?? makeDisabledParallelSearch(),
  });
  const started = await startServer({ layer: appLayer, host: "127.0.0.1", port: 0 });
  state = { started, storageRoot, token: "" };
  await resetDatabase();
  await seedFixtures(false);
  state = { started, storageRoot, token: await issueToken(id.alice) };
  return { started, storageRoot, token: state.token, costs, embeddings };
};

const startLiveHarness = async () => {
  const key = process.env.OPENROUTER_API_KEY;
  if (key === undefined || key.length === 0) {
    throw new Error("OPENROUTER_API_KEY is required when RUN_LIVE_LLM_SMOKE=1");
  }
  const clock = makeTestClock(initialTime);
  const storageRoot = await mkdtemp(join(tmpdir(), "great-minds-query-live-storage-"));
  const configLayer = Layer.succeed(
    AppConfig,
    testConfig(databaseUrl(), storageRoot, {
      openRouterApiKey: Option.some(Redacted.make(key)),
      queryModel: process.env.RUN_LIVE_LLM_MODEL ?? "openai/gpt-4o-mini",
      queryFallbackModels: [],
    }),
  );
  const appLayer = makeAppLayer({
    config: configLayer,
    clock: clock.layer,
    mailer: makeTestMailer().layer,
    logger: StructuredLoggerLive,
    parallelSearch: makeDisabledParallelSearch(),
  });
  const started = await startServer({ layer: appLayer, host: "127.0.0.1", port: 0 });
  state = { started, storageRoot, token: "" };
  await resetDatabase();
  await seedFixtures(false);
  state = { started, storageRoot, token: await issueToken(id.alice) };
};

const seedFixtures = async (webSearch: boolean) => {
  await runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db
        .insert(users)
        .values({ id: id.alice, email: "alice-query@example.com", createdAt: initialTime })
        .pipe(Effect.orDie);
      yield* db
        .insert(vaults)
        .values({ id: id.vault, name: "Query Vault", ownerId: id.alice, createdAt: initialTime })
        .pipe(Effect.orDie);
      yield* db
        .insert(vaultMemberships)
        .values({
          id: "00000000-0000-4000-8000-000000020701",
          vaultId: id.vault,
          userId: id.alice,
          role: "OWNER",
        })
        .pipe(Effect.orDie);
      yield* db
        .insert(topics)
        .values([
          {
            topicId: id.topicAlpha,
            vaultId: id.vault,
            slug: "alpha",
            title: "Alpha",
            description: "Alpha topic",
            articleStatus: "rendered",
          },
          {
            topicId: id.topicBeta,
            vaultId: id.vault,
            slug: "beta",
            title: "Beta",
            description: "Beta topic",
            articleStatus: "rendered",
          },
        ])
        .pipe(Effect.orDie);
      yield* db
        .insert(wikiArticles)
        .values([
          {
            id: id.articleAlpha,
            vaultId: id.vault,
            topicId: id.topicAlpha,
            filePath: "wiki/alpha.md",
            fileHash: "wiki-alpha-file",
            bodyHash: "wiki-alpha-body",
            title: "Alpha",
            precis: "Alpha precis about capital and value.",
            tags: ["theory"],
          },
          {
            id: id.articleBeta,
            vaultId: id.vault,
            topicId: id.topicBeta,
            filePath: "wiki/beta.md",
            fileHash: "wiki-beta-file",
            bodyHash: "wiki-beta-body",
            title: "Beta",
            precis: "Beta precis.",
            tags: [],
          },
        ])
        .pipe(Effect.orDie);
      yield* db
        .insert(backlinks)
        .values([
          { sourceArticleId: id.articleAlpha, targetArticleId: id.articleBeta },
          { sourceArticleId: id.articleBeta, targetArticleId: id.articleAlpha },
        ])
        .pipe(Effect.orDie);
      yield* db
        .insert(sourceDocuments)
        .values({
          id: id.source,
          vaultId: id.vault,
          filePath: "raw/texts/source.md",
          fileHash: "source-file",
          bodyHash: "source-body",
          sourceType: "document",
          title: "Raw Source",
          author: "Lenin",
          publishedDate: "1916",
          genre: "theoretical",
          tags: ["theory", "capital"],
        })
        .pipe(Effect.orDie);
      yield* db
        .insert(searchIndex)
        .values([
          {
            vaultId: id.vault,
            path: "wiki/alpha.md",
            chunkIndex: 0,
            heading: "Alpha heading",
            body: "Capital appears in the alpha article.",
            contentHash: "alpha-0",
            tsv: sql`to_tsvector('english', 'Capital appears in the alpha article.')`,
          },
          {
            vaultId: id.vault,
            path: "raw/texts/source.md",
            chunkIndex: 0,
            heading: "Raw heading",
            body: "Value appears in the raw source.",
            contentHash: "raw-0",
            tsv: sql`to_tsvector('english', 'Value appears in the raw source.')`,
          },
          {
            vaultId: id.vault,
            path: "raw/texts/source.md",
            chunkIndex: 1,
            heading: "Raw heading",
            body: "More value context appears here.",
            contentHash: "raw-1",
            tsv: sql`to_tsvector('english', 'More value context appears here.')`,
          },
        ])
        .pipe(Effect.orDie);
    }),
  );
  await writeVaultFile(
    id.vault,
    "config.yaml",
    `name: Query Vault\nthematic_hint: Prefer source-grounded answers.\nkinds:\n  - person\n  - concept\nweb_search: ${webSearch ? "true" : "false"}\n`,
  );
  await writeVaultFile(
    id.vault,
    "wiki/alpha.md",
    "---\ntitle: Alpha\n---\nAlpha article body with capital.",
  );
  await writeVaultFile(
    id.vault,
    "raw/texts/source.md",
    "---\ntitle: Raw Source\n---\n" + "Long raw source text. ".repeat(1200),
  );
};

const api = async (path: string, body: unknown) => {
  return await apiWithToken(path, body, currentState().token);
};

const apiWithToken = async (path: string, body: unknown, token: string) => {
  const response = await fetch(`${currentState().started.url}/v1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, text };
};

const sseBlock = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const vector1024 = (head: readonly number[]) => [
  ...head,
  ...Array.from({ length: 1024 - head.length }, () => 0),
];

const queryPath = `/vaults/${id.vault}/query`;

afterEach(async () => {
  if (state !== undefined) {
    const root = state.storageRoot;
    await state.started.close();
    await rm(root, { recursive: true, force: true });
    state = undefined;
  }
});

describe("query stream", () => {
  it("returns HTTP errors before opening SSE for non-member, missing vault, and missing LLM key", async () => {
    const language = makeScriptedLanguageModel({ streams: [] });
    await startHarness({ language });

    await insertUser(id.bob, "bob-query@example.com");
    const bobToken = await issueToken(id.bob);
    const nonMember = await apiWithToken(
      queryPath,
      { question: "No access", history: [] },
      bobToken,
    );
    expect(nonMember.response.status).toBe(403);
    expect(nonMember.response.headers.get("content-type") ?? "").not.toContain(
      "text/event-stream",
    );
    expect(JSON.parse(nonMember.text)).toEqual({
      detail: "Only vault members can perform this action",
    });

    const unknown = await api(
      "/vaults/00000000-0000-4000-8000-000000029999/query",
      { question: "Missing", history: [] },
    );
    expect(unknown.response.status).toBe(404);
    expect(unknown.response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    expect(JSON.parse(unknown.text)).toEqual({ detail: "Vault not found" });

    await currentState().started.close();
    await rm(currentState().storageRoot, { recursive: true, force: true });
    state = undefined;

    const noKeyLanguage = makeScriptedLanguageModel({ streams: [] });
    await startHarness({
      language: noKeyLanguage,
      configOverrides: { openRouterApiKey: Option.none() },
    });
    const noKey = await api(queryPath, { question: "No key", history: [] });
    expect(noKey.response.status).toBe(503);
    expect(noKey.response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    expect(JSON.parse(noKey.text)).toEqual({
      detail: "LLM service not configured (OPENROUTER_API_KEY missing)",
    });
    expect(noKeyLanguage.streamCalls).toHaveLength(0);
  });

  it("streams the full tool loop with exact SSE bytes and records cost", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [
            toolCallPart(0, "tc-list", "list_articles", {
              contains: "Alpha",
              sort: "central",
              page: "1",
            }),
            toolCallPart(1, "tc-query", "query_documents", {
              tags: ["theory"],
              author: "Lenin",
            }),
            toolCallPart(2, "tc-search", "search_content", { query: "capital" }),
            toolCallPart(3, "tc-search-doc", "search_in_document", {
              path: "raw/texts/source.md",
              query: "value",
            }),
            finishPart("tool_calls", "gen-round-1", { cost: 0.01 }),
          ],
        },
        {
          kind: "parts",
          parts: [
            toolCallPart(0, "tc-read-wiki", "read_document", { path: "wiki/alpha.md" }),
            toolCallPart(1, "tc-read-raw", "read_document", { path: "raw/texts/source.md" }),
            toolCallPart(2, "tc-expand", "expand_context", {
              path: "raw/texts/source.md",
              start: "0",
              end: "1",
            }),
            toolCallPart(3, "tc-links", "linked_articles", { path: "wiki/alpha.md" }),
            finishPart("tool_calls", "gen-round-2", { cost: 0.02 }),
          ],
        },
        {
          kind: "parts",
          parts: [tokenPart("Answer."), finishPart("stop", "gen-final", { cost: 0.03 })],
        },
      ],
    });
    const costs = makeCostLookup(new Map());
    await startHarness({ language, costs });

    const { response, text } = await api(queryPath, { question: "Explain value.", history: [] });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(text).toBe(
      sseBlock("source_pending", {
        call_id: "tc-list",
        source: { type: "query", filters: { contains: "Alpha", sort: "central" } },
      }) +
        sseBlock("source_pending", {
          call_id: "tc-query",
          source: { type: "query", filters: { tags: ["theory"], author: "Lenin" } },
        }) +
        sseBlock("source_pending", {
          call_id: "tc-search",
          source: { type: "search", query: "capital", scope: "kb" },
        }) +
        sseBlock("source_pending", {
          call_id: "tc-search-doc",
          source: {
            type: "search",
            query: "value",
            scope: "kb",
            path: "raw/texts/source.md",
            title: null,
          },
        }) +
        sseBlock("source_settled", { call_id: "tc-list" }) +
        sseBlock("source", { type: "query", filters: { contains: "Alpha", sort: "central" } }) +
        sseBlock("source_settled", { call_id: "tc-query" }) +
        sseBlock("source", { type: "query", filters: { tags: ["theory"], author: "Lenin" } }) +
        sseBlock("source_settled", { call_id: "tc-search" }) +
        sseBlock("source", { type: "search", query: "capital", scope: "kb" }) +
        sseBlock("source_settled", { call_id: "tc-search-doc" }) +
        sseBlock("source", {
          type: "search",
          query: "value",
          scope: "kb",
          path: "raw/texts/source.md",
          title: "Raw Source",
        }) +
        sseBlock("source_pending", {
          call_id: "tc-read-wiki",
          source: { type: "article", path: "wiki/alpha.md", title: null },
        }) +
        sseBlock("source_pending", {
          call_id: "tc-read-raw",
          source: { type: "raw", path: "raw/texts/source.md", title: null },
        }) +
        sseBlock("source_pending", {
          call_id: "tc-expand",
          source: {
            type: "raw",
            path: "raw/texts/source.md",
            title: null,
            start: 0,
            end: 1,
          },
        }) +
        sseBlock("source_pending", {
          call_id: "tc-links",
          source: { type: "links", path: "wiki/alpha.md", title: null },
        }) +
        sseBlock("source_settled", { call_id: "tc-read-wiki" }) +
        sseBlock("source", { type: "article", path: "wiki/alpha.md", title: "Alpha" }) +
        sseBlock("source_settled", { call_id: "tc-read-raw" }) +
        sseBlock("source", { type: "raw", path: "raw/texts/source.md", title: "Raw Source" }) +
        sseBlock("source_settled", { call_id: "tc-expand" }) +
        sseBlock("source", {
          type: "raw",
          path: "raw/texts/source.md",
          title: "Raw Source",
          start: 0,
          end: 1,
        }) +
        sseBlock("source_settled", { call_id: "tc-links" }) +
        sseBlock("source", { type: "links", path: "wiki/alpha.md", title: "Alpha" }) +
        sseBlock("token", { text: "Answer." }) +
        sseBlock("done", {}),
    );

    const rows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.select().from(llmCostEvents).pipe(Effect.orDie);
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("query.stream");
    expect(rows[0].costUsd).toBe("0.060000");
    expect(costs.lookups).toEqual([]);
  });

  it("threads BTW history for both session and document-reader flows", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        { kind: "parts", parts: [tokenPart("A"), finishPart("stop", "btw-1")] },
        { kind: "parts", parts: [tokenPart("B"), finishPart("stop", "btw-2")] },
      ],
    });
    await startHarness({ language });

    await api(queryPath, {
      question: "BTW follow-up",
      mode: "btw",
      history: [
        { role: "user", content: "Parent question" },
        { role: "assistant", content: "Parent answer" },
        {
          role: "user",
          content: 'Passage:\n> Parent answer\n\nHighlighted: "answer"\n\nFirst BTW',
        },
        { role: "assistant", content: "First BTW answer" },
      ],
    });
    await api(queryPath, {
      question: "Doc BTW follow-up",
      mode: "btw",
      origin_path: "raw/texts/source.md",
      history: [
        { role: "user", content: 'Passage:\n> Raw quote\n\nHighlighted: "quote"\n\nFirst doc BTW' },
        { role: "assistant", content: "First doc answer" },
      ],
    });

    const sessionMessages = language.streamCalls[0].messages;
    expect(sessionMessages[0]).toMatchObject({ role: "system" });
    expect(String(sessionMessages[0].content)).toContain("This is a BTW");
    expect(sessionMessages.some((message) => message.role === "tool")).toBe(false);
    expect(sessionMessages.slice(1, 5)).toEqual([
      { role: "user", content: "Parent question" },
      { role: "assistant", content: "Parent answer" },
      { role: "user", content: 'Passage:\n> Parent answer\n\nHighlighted: "answer"\n\nFirst BTW' },
      { role: "assistant", content: "First BTW answer" },
    ]);

    const docMessages = language.streamCalls[1].messages;
    expect(docMessages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          function: {
            name: "read_document",
            arguments: JSON.stringify({ path: "raw/texts/source.md" }),
          },
        },
      ],
    });
    expect(docMessages[2]).toMatchObject({ role: "tool" });
    expect(String(docMessages[2].content)).toContain("# raw/texts/source.md [Query Vault]");
    expect(docMessages.slice(3, 5)).toEqual([
      { role: "user", content: 'Passage:\n> Raw quote\n\nHighlighted: "quote"\n\nFirst doc BTW' },
      { role: "assistant", content: "First doc answer" },
    ]);
  });

  it("preloads origin documents with raw frontmatter intact", async () => {
    const language = makeScriptedLanguageModel({
      streams: [{ kind: "parts", parts: [tokenPart("A"), finishPart("stop", "origin-frontmatter")] }],
    });
    await startHarness({ language });

    await api(queryPath, {
      question: "Read origin",
      origin_path: "wiki/alpha.md",
      history: [],
    });

    const messages = language.streamCalls[0].messages;
    expect(messages[2]).toMatchObject({ role: "tool" });
    expect(String(messages[2].content)).toContain("---\ntitle: Alpha\n---\nAlpha article body");
  });

  it("hybrid search fuses BM25 and vector ranks with deterministic RRF order", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [
            toolCallPart(0, "tc-search", "search_content", { query: "dual power" }),
            finishPart("tool_calls", "hybrid-round"),
          ],
        },
        { kind: "parts", parts: [tokenPart("Hybrid"), finishPart("stop", "hybrid-final")] },
      ],
    });
    const embeddings = makeEmbeddings(new Map([["dual power", vector1024([1, 0, 0])]]));
    await startHarness({ language, embeddings });
    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.delete(searchIndex).pipe(Effect.orDie);
        yield* db
          .insert(searchIndex)
          .values([
            {
              vaultId: id.vault,
              path: "raw/texts/semantic.md",
              chunkIndex: 0,
              heading: "Semantic",
              body: "Assemblies coordinate strike committees through recallable delegates.",
              contentHash: "semantic-0",
              tsv: sql`to_tsvector('english', 'Assemblies coordinate strike committees through recallable delegates.')`,
              embedding: vector1024([1, 0, 0]),
            },
            {
              vaultId: id.vault,
              path: "raw/texts/bm25-first.md",
              chunkIndex: 0,
              heading: "Lexical",
              body: "dual power dual power dual power",
              contentHash: "bm25-0",
              tsv: sql`to_tsvector('english', 'dual power dual power dual power')`,
            },
            {
              vaultId: id.vault,
              path: "raw/texts/bm25-second.md",
              chunkIndex: 0,
              heading: "Lexical",
              body: "dual power",
              contentHash: "bm25-1",
              tsv: sql`to_tsvector('english', 'dual power')`,
            },
          ])
          .pipe(Effect.orDie);
      }),
    );

    const { text } = await api(queryPath, { question: "Find dual power" });

    expect(text).toContain(sseBlock("source", { type: "search", query: "dual power", scope: "kb" }));
    expect(embeddings.calls).toEqual([["dual power"]]);
    const toolMessage = language.streamCalls[1].messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "tc-search",
    );
    const content = String(toolMessage?.content);
    const expectedScores = {
      semantic: 1 / 61,
      bm25First: 1 / 61,
      bm25Second: 1 / 62,
    };
    expect(expectedScores.semantic).toBe(expectedScores.bm25First);
    expect(content).toContain("raw/texts/semantic.md");
    expect(content).toContain("raw/texts/bm25-first.md");
    expect(content).toContain("raw/texts/bm25-second.md");
    expect(content.indexOf("raw/texts/semantic.md")).toBeLessThan(
      content.indexOf("raw/texts/bm25-first.md"),
    );
    expect(content.indexOf("raw/texts/bm25-first.md")).toBeLessThan(
      content.indexOf("raw/texts/bm25-second.md"),
    );
    expect(content).not.toContain("Assemblies coordinate strike committees dual power");
  });

  it("gates web_search off and on, using Parallel facts extraction when enabled", async () => {
    const offLanguage = makeScriptedLanguageModel({
      streams: [{ kind: "parts", parts: [tokenPart("Off"), finishPart("stop", "off")] }],
    });
    await startHarness({ language: offLanguage });
    await api(queryPath, { question: "Can you use the web?" });
    expect(offLanguage.streamCalls[0].tools.map((tool) => tool.function.name)).not.toContain(
      "web_search",
    );
    expect(String(offLanguage.streamCalls[0].messages[0].content)).not.toContain("WEB SEARCH");
    await currentState().started.close();
    await rm(currentState().storageRoot, { recursive: true, force: true });
    state = undefined;

    const missingParallelLanguage = makeScriptedLanguageModel({
      streams: [
        { kind: "parts", parts: [tokenPart("No parallel"), finishPart("stop", "no-parallel")] },
      ],
    });
    await startHarness({ language: missingParallelLanguage });
    await resetDatabase();
    await seedFixtures(true);
    state = { ...currentState(), token: await issueToken(id.alice) };
    await api(queryPath, { question: "Can config enable web without key?" });
    expect(missingParallelLanguage.streamCalls[0].tools.map((tool) => tool.function.name)).not.toContain(
      "web_search",
    );
    expect(String(missingParallelLanguage.streamCalls[0].messages[0].content)).not.toContain(
      "WEB SEARCH",
    );
    await currentState().started.close();
    await rm(currentState().storageRoot, { recursive: true, force: true });
    state = undefined;

    const onLanguage = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [
            toolCallPart(0, "tc-web", "web_search", { query: "recent factual query" }),
            finishPart("tool_calls", "web-round"),
          ],
        },
        { kind: "parts", parts: [tokenPart("On"), finishPart("stop", "web-final")] },
      ],
      completions: [
        {
          text: "```json\n" + JSON.stringify({ results: [{ index: 1, facts: ["Fact one"] }] }) + "\n```",
          generationId: "extract-gen",
          usage: { cost: 0.004 },
        },
      ],
    });
    const parallel = makeParallelSearch([
      {
        title: "External Result",
        url: "https://example.test/result",
        excerpts: ["Fact one plus analysis."],
      },
    ]);
    await startHarness({ language: onLanguage, parallel });
    await resetDatabase();
    await seedFixtures(true);
    state = { ...currentState(), token: await issueToken(id.alice) };

    const { text } = await api(queryPath, { question: "Need current facts" });
    expect(onLanguage.streamCalls[0].tools.map((tool) => tool.function.name)).toContain(
      "web_search",
    );
    expect(String(onLanguage.streamCalls[0].messages[0].content)).toContain("WEB SEARCH");
    expect(parallel.calls).toEqual([
      { question: "Need current facts", query: "recent factual query" },
    ]);
    expect(onLanguage.completeCalls[0].model).toBe("extract/test-model");
    expect(text).toContain(
      sseBlock("source", { type: "search", query: "recent factual query", scope: "web" }),
    );
    expect(text.endsWith(sseBlock("done", {}))).toBe(true);
  });

  it("emits sanitized setup and mid-loop errors without done", async () => {
    const setupLanguage = makeScriptedLanguageModel({ streams: [] });
    await startHarness({ language: setupLanguage });
    await writeVaultFile(id.vault, "config.yaml", ": bad: [");
    const setup = await api(queryPath, { question: "break setup" });
    expect(setup.text).toBe(
      sseBlock("error", {
        message: "Something went wrong while answering. Try again in a minute.",
      }),
    );
    await currentState().started.close();
    await rm(currentState().storageRoot, { recursive: true, force: true });
    state = undefined;

    const loopLanguage = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [
            toolCallPart(0, "tc-list", "list_articles", { contains: "Alpha" }),
            finishPart("tool_calls", "ok-round"),
          ],
        },
        { kind: "throw", error: new Error("secret provider detail") },
      ],
    });
    await startHarness({ language: loopLanguage });
    const loop = await api(queryPath, { question: "break loop" });
    expect(loop.text).toBe(
      sseBlock("source_pending", {
        call_id: "tc-list",
        source: { type: "query", filters: { contains: "Alpha" } },
      }) +
        sseBlock("source_settled", { call_id: "tc-list" }) +
        sseBlock("source", { type: "query", filters: { contains: "Alpha" } }) +
        sseBlock("error", {
          message: "Something went wrong while answering. Try again in a minute.",
        }),
    );
    expect(loop.text).not.toContain("secret provider detail");
    expect(loop.text).not.toContain("event: done");
  });

  it("emits an error and skips the batch when tool arguments are malformed JSON", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [
            malformedToolCallPart(0, "tc-bad", "search_content", '{"query":'),
            toolCallPart(1, "tc-list", "list_articles", { contains: "Alpha" }),
            finishPart("tool_calls", "bad-tool-round"),
          ],
        },
      ],
    });
    await startHarness({ language });

    const malformed = await api(queryPath, { question: "break tool args" });

    expect(malformed.text).toBe(
      sseBlock("error", { message: "Malformed tool args for search_content" }),
    );
    expect(malformed.text).not.toContain("event: done");
    expect(malformed.text).not.toContain("Alpha");
  });

  it("settles a pending source when a tool misses without emitting a source", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [
            toolCallPart(0, "tc-missing", "read_document", { path: "wiki/missing.md" }),
            finishPart("tool_calls", "missing-round"),
          ],
        },
        { kind: "parts", parts: [tokenPart("Recovered"), finishPart("stop", "missing-final")] },
      ],
    });
    await startHarness({ language });

    const result = await api(queryPath, { question: "missing source" });

    expect(result.text).toBe(
      sseBlock("source_pending", {
        call_id: "tc-missing",
        source: { type: "article", path: "wiki/missing.md", title: null },
      }) +
        sseBlock("source_settled", { call_id: "tc-missing" }) +
        sseBlock("token", { text: "Recovered" }) +
        sseBlock("done", {}),
    );
    expect(result.text).not.toContain("event: source\n");
  });

  it("surfaces invalid list_articles sort instead of silently defaulting", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [
            toolCallPart(0, "tc-list", "list_articles", { contains: "Alpha", sort: "bogus" }),
            finishPart("tool_calls", "bad-sort-round"),
          ],
        },
      ],
    });
    await startHarness({ language });

    const result = await api(queryPath, { question: "bad sort" });

    expect(result.text).toBe(
      sseBlock("source_pending", {
        call_id: "tc-list",
        source: { type: "query", filters: { contains: "Alpha", sort: "bogus" } },
      }) +
        sseBlock("source_settled", { call_id: "tc-list" }) +
        sseBlock("error", {
          message: "Something went wrong while answering. Try again in a minute.",
        }),
    );
    expect(result.text).not.toContain("event: done");
  });

  it("uses exact genre matching while keeping query_documents limit clamped", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [
            toolCallPart(0, "tc-query", "query_documents", {
              genre: "theor",
              limit: 100,
            }),
            finishPart("tool_calls", "genre-round"),
          ],
        },
        { kind: "parts", parts: [tokenPart("Done"), finishPart("stop", "genre-final")] },
      ],
    });
    await startHarness({ language });

    await api(queryPath, { question: "genre" });

    const toolMessage = language.streamCalls[1].messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "tc-query",
    );
    expect(String(toolMessage?.content)).toContain(
      'No documents match the filters: {"genre":"theor","limit":50}',
    );
  });

  it("continues invisibly on retryable primary-model fallback", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        { kind: "throw", error: retryableModelError("429") },
        { kind: "parts", parts: [tokenPart("Fallback"), finishPart("stop", "fallback-gen")] },
      ],
    });
    await startHarness({ language });

    const { text } = await api(queryPath, { question: "fallback please" });

    expect(language.streamCalls.map((call) => call.model)).toEqual([
      "primary/test-model",
      "fallback/test-model",
    ]);
    expect(text).toBe(sseBlock("token", { text: "Fallback" }) + sseBlock("done", {}));
  });

  it("falls back to generation cost lookup after done when streamed cost is absent", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [tokenPart("Lookup"), finishPart("stop", "lookup-gen")],
        },
      ],
    });
    const costs = makeCostLookup(new Map([["lookup-gen", 0.042]]));
    await startHarness({ language, costs });

    const { text } = await api(queryPath, { question: "cost fallback" });

    expect(text).toBe(sseBlock("token", { text: "Lookup" }) + sseBlock("done", {}));
    expect(costs.lookups).toEqual(["lookup-gen"]);
    const rows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.select().from(llmCostEvents).pipe(Effect.orDie);
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].costUsd).toBe("0.042000");
  });

  it("does not write a cost row or lookup fallback for zero streamed cost", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [tokenPart("Free"), finishPart("stop", "zero-gen", { cost: 0 })],
        },
      ],
    });
    const costs = makeCostLookup(new Map([["zero-gen", 1]]));
    await startHarness({ language, costs });

    const { text } = await api(queryPath, { question: "zero cost" });

    expect(text).toBe(sseBlock("token", { text: "Free" }) + sseBlock("done", {}));
    expect(costs.lookups).toEqual([]);
    const rows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.select().from(llmCostEvents).pipe(Effect.orDie);
      }),
    );
    expect(rows).toHaveLength(0);
  });

  it("drafts thematic hints through the LLM layer", async () => {
    const language = makeScriptedLanguageModel({
      completions: [{ text: "Prefer debate-centered framing.", generationId: "hint-gen" }],
    });
    await startHarness({ language });

    const ok = await api("/vaults/draft-hint", { description: "center debates" });
    expect(ok.response.status).toBe(200);
    expect(JSON.parse(ok.text)).toEqual({ thematic_hint: "Prefer debate-centered framing." });
    expect(language.completeCalls[0].messages[0]).toEqual({
      role: "system",
      content:
        "You translate a user's free-form description of their knowledge base " +
        "into a one-paragraph editorial steer for an LLM that decides how to " +
        "frame canonical wiki topics. The steer should describe what kinds of " +
        "framings to prefer (e.g. event-centric vs biographical, debate-centric " +
        "vs descriptive) given the user's domain. Keep it 2–4 sentences, " +
        "concrete, and actionable. Do not include preamble, headings, or " +
        "quotation marks — return only the steer text.",
    });

    const bad = await api("/vaults/draft-hint", { description: "   " });
    expect(bad.response.status).toBe(400);
    expect(JSON.parse(bad.text)).toEqual({ detail: "description required" });
  });

  it("returns draft-hint 503 before blank-description validation when the LLM key is missing", async () => {
    const language = makeScriptedLanguageModel({ completions: [], hasApiKey: false });
    await startHarness({
      language,
      configOverrides: { openRouterApiKey: Option.none() },
    });

    const response = await api("/vaults/draft-hint", { description: "   " });

    expect(response.response.status).toBe(503);
    expect(JSON.parse(response.text)).toEqual({
      detail: "LLM service not configured (OPENROUTER_API_KEY missing)",
    });
    expect(language.completeCalls).toHaveLength(0);
  });

  it.skipIf(process.env.RUN_LIVE_LLM_SMOKE !== "1")(
    "completes a live one-round OpenRouter smoke and records cost",
    async () => {
      await startLiveHarness();

      const { response, text } = await api(queryPath, {
        question:
          "Use list_articles first to orient on Alpha, then answer in one short sentence with a citation.",
      });

      expect(response.status).toBe(200);
      expect(text).toContain("event: source\n");
      expect(text).toContain("event: done\n");
      expect(text).not.toContain("event: error\n");
      const rows = await runDb(
        Effect.gen(function* () {
          const db = yield* Database;
          return yield* db.select().from(llmCostEvents).pipe(Effect.orDie);
        }),
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(Number(rows[0].costUsd)).toBeGreaterThan(0);
    },
  );
});
