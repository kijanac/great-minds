import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  authCodes,
  backlinks,
  Database,
  llmCostEvents,
  prompts,
  replies,
  searchIndex,
  sourceDocuments,
  topics,
  users,
  vaultMemberships,
  vaults,
  wikiArticles,
} from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, Option, Redacted } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { makeAppLayer } from "../src/app-layer.ts";
import { ClockService, makeTestClock } from "../src/clock.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { promptContentHash } from "../src/crypto.ts";
import { StructuredLogger, StructuredLoggerLive } from "../src/logging.ts";
import { makeTestMailer } from "../src/mailer.ts";
import { RepliesService } from "../src/replies.ts";
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

type TestServices =
  | AppConfig
  | Database
  | ClockService
  | RepliesService
  | StructuredLogger
  | TokenService;

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
  webauthnRpId: "localhost",
  webauthnOrigins: ["http://localhost:5173"],
  webauthnRpName: "Great Minds",
  resendApiKey: Option.none(),
  resendFromEmail: Option.none(),
  dataDir,
  storageBackend: "local",
  r2AccountId: Option.none(),
  r2AccessKeyId: Option.none(),
  r2SecretAccessKey: Option.none(),
  r2BucketName: Option.none(),
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
  allowPrivateUrlFetch: false,
  serverHost: "127.0.0.1",
  serverPort: 0,
});

const runDb = <A>(effect: Effect.Effect<A, unknown, TestServices>) =>
  currentState().started.runtime.runPromise(effect);

const resetDatabase = () =>
  runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d.delete(authCodes)).pipe(Effect.orDie);
      yield* db.query((d) => d.delete(users)).pipe(Effect.orDie);
    }),
  );

const writeVaultFile = async (vaultId: string, path: string, content: string) => {
  const fullPath = join(currentState().storageRoot, "vaults", vaultId, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
};

const writeUserFile = async (userId: string, path: string, content: string) => {
  const fullPath = join(currentState().storageRoot, "users", userId, path);
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
      yield* db.query((d) => d
        .insert(users)
        .values({ id: userId, email, createdAt: initialTime }))
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
      yield* db.query((d) => d
        .insert(users)
        .values({ id: id.alice, email: "alice-query@example.com", createdAt: initialTime }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(vaults)
        .values({ id: id.vault, name: "Query Vault", ownerId: id.alice, createdAt: initialTime }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(vaultMemberships)
        .values({
          id: "00000000-0000-4000-8000-000000020701",
          vaultId: id.vault,
          userId: id.alice,
          role: "OWNER",
        }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
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
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
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
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(backlinks)
        .values([
          { sourceArticleId: id.articleAlpha, targetArticleId: id.articleBeta },
          { sourceArticleId: id.articleBeta, targetArticleId: id.articleAlpha },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
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
        }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
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
        ]))
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
  const payload =
    path.endsWith("/replies") &&
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body)
      ? { reply_id: crypto.randomUUID(), ...body }
      : body;
  const response = await fetch(`${currentState().started.url}/v1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return { response, text };
};

type ReplySnapshot = {
  readonly reply_id: string;
  readonly status: "running" | "completed" | "failed";
  readonly answer: string;
  readonly sources: readonly Record<string, unknown>[];
  readonly error: string | null;
  readonly version: number;
};

const replySnapshots = (text: string): ReplySnapshot[] =>
  text.split("\n\n").flatMap((block) => {
    const lines = block.split("\n");
    const event =
      lines.find((line) => line.startsWith("event:"))?.slice(6).trimStart() ?? "message";
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return event === "message" && data.length > 0
      ? [JSON.parse(data) as ReplySnapshot]
      : [];
  });

const runReply = async (body: Record<string, unknown>) => {
  const created = await api(repliesPath, {
    kind: "ephemeral",
    mode: "query",
    history: [],
    ...body,
  });
  if (created.response.status !== 202) {
    return { ...created, snapshots: [] as ReplySnapshot[] };
  }
  const { reply_id: replyId } = JSON.parse(created.text) as { reply_id: string };
  const streamed = await tailReply(replyId);
  return { ...streamed, snapshots: replySnapshots(streamed.text) };
};

const tailReply = async (replyId: string) => {
  const response = await fetch(
    `${currentState().started.url}/v1/vaults/${id.vault}/replies/${replyId}/stream`,
    {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${currentState().token}`,
      },
    },
  );
  const text = await response.text();
  return { response, text };
};

const retryReply = async (replyId: string, nextReplyId = crypto.randomUUID()) => {
  const response = await fetch(
    `${currentState().started.url}/v1/vaults/${id.vault}/replies/${replyId}/retry`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${currentState().token}`,
      },
      body: JSON.stringify({ reply_id: nextReplyId }),
    },
  );
  const text = await response.text();
  return { response, text };
};

const readSessionEvents = async (sessionId: string) => {
  const content = await readFile(
    join(currentState().storageRoot, "vaults", id.vault, "sessions", `${sessionId}.jsonl`),
    "utf8",
  );
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const getWithToken = (path: string) =>
  fetch(`${currentState().started.url}/v1${path}`, {
    headers: { authorization: `Bearer ${currentState().token}` },
  });

const vector1024 = (head: readonly number[]) => [
  ...head,
  ...Array.from({ length: 1024 - head.length }, () => 0),
];

const repliesPath = `/vaults/${id.vault}/replies`;

afterEach(async () => {
  if (state !== undefined) {
    const root = state.storageRoot;
    await state.started.close();
    await rm(root, { recursive: true, force: true });
    state = undefined;
  }
});

describe("query stream", () => {
  it("builds personal origin context from user storage and degrades missing refs", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        { kind: "parts", parts: [tokenPart("Stored answer."), finishPart("stop")] },
        { kind: "parts", parts: [tokenPart("Missing answer."), finishPart("stop")] },
      ],
    });
    await startHarness({ language });
    await writeUserFile(
      id.alice,
      "refs/personal.md",
      "---\nsource_type: document\nurl: https://example.com/personal\norigin: example.com\n---\nPersonal reference body. ^p0\n",
    );
    await writeVaultFile(
      id.vault,
      "refs/personal.md",
      "This vault file must not become the personal origin context.",
    );

    const stored = await runReply({
      mode: "btw",
      question: "What does the reference say?",
      origin_path: "refs/personal.md",
      origin_scope: "personal",
    });
    expect(stored.response.status).toBe(200);
    expect(stored.snapshots.at(-1)?.status).toBe("completed");
    const storedMessages = JSON.stringify(language.streamCalls[0]?.messages);
    expect(storedMessages).toContain("Personal reference body.");
    expect(storedMessages).not.toContain("This vault file must not");

    const missing = await runReply({
      mode: "btw",
      question: "What does the missing reference say?",
      origin_path: "refs/bogus.md",
      origin_scope: "personal",
    });
    expect(missing.response.status).toBe(200);
    expect(missing.snapshots.at(-1)?.status).toBe("completed");
    expect(JSON.stringify(language.streamCalls[1]?.messages)).toContain(
      "Document not found: refs/bogus.md",
    );
  });

  it("returns HTTP errors before opening SSE for non-member, missing vault, and missing LLM key", async () => {
    const language = makeScriptedLanguageModel({ streams: [] });
    await startHarness({ language });

    await insertUser(id.bob, "bob-query@example.com");
    const bobToken = await issueToken(id.bob);
    const nonMember = await apiWithToken(
      repliesPath,
      { kind: "ephemeral", mode: "query", question: "No access", history: [] },
      bobToken,
    );
    expect(nonMember.response.status).toBe(403);
    expect(nonMember.response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    expect(JSON.parse(nonMember.text)).toMatchObject({
      detail: "Only vault members can perform this action",
    });

    const unknown = await api("/vaults/00000000-0000-4000-8000-000000029999/replies", {
      kind: "ephemeral",
      mode: "query",
      question: "Missing",
      history: [],
    });
    expect(unknown.response.status).toBe(404);
    expect(unknown.response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    expect(JSON.parse(unknown.text)).toMatchObject({ detail: "Vault not found" });

    await currentState().started.close();
    await rm(currentState().storageRoot, { recursive: true, force: true });
    state = undefined;

    const noKeyLanguage = makeScriptedLanguageModel({ streams: [] });
    await startHarness({
      language: noKeyLanguage,
      configOverrides: { openRouterApiKey: Option.none() },
    });
    const noKey = await api(repliesPath, {
      kind: "ephemeral",
      mode: "query",
      question: "No key",
      history: [],
    });
    expect(noKey.response.status).toBe(503);
    expect(noKey.response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    expect(JSON.parse(noKey.text)).toMatchObject({
      detail: "LLM service not configured (OPENROUTER_API_KEY missing)",
    });
    expect(noKeyLanguage.streamCalls).toHaveLength(0);
  });

  it("persists pending and final exchange events while the reply tail reaches completed", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [tokenPart("Durable answer."), finishPart("stop", "durable-generation")],
        },
      ],
    });
    await startHarness({ language });

    const created = await api(repliesPath, {
      kind: "exchange",
      exchange_id: "ex-durable",
      create: {
        idempotency_key: "reply-session-idempotency",
        origin: { doc_path: "wiki/alpha.md", origin_scope: "vault", anchor: null, paragraph: null, paragraph_index: null },
      },
      question: "Persist this answer",
      mode: "query",
      history: [],
    });
    expect(created.response.status).toBe(202);
    const identifiers = JSON.parse(created.text) as {
      reply_id: string;
      session_id: string;
    };

    const submittedEvents = await readSessionEvents(identifiers.session_id);
    expect(
      submittedEvents.some(
        (event) =>
          event.type === "exchange" &&
          event.exId === "ex-durable" &&
          event.answer === "" &&
          event.reply_id === identifiers.reply_id,
      ),
    ).toBe(true);

    const tail = await tailReply(identifiers.reply_id);
    expect(replySnapshots(tail.text).at(-1)).toMatchObject({
      status: "completed",
      answer: "Durable answer.",
    });
    const replyRows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select()
          .from(replies)
          .where(eq(replies.id, identifiers.reply_id)))
          .pipe(Effect.orDie);
      }),
    );
    expect(replyRows[0]).toMatchObject({
      dispatchedTaskId: identifiers.reply_id,
      generationCursor: 1,
      activeGenerationStep: null,
      activeGenerationKind: null,
      activeGenerationKey: null,
    });
    expect(replyRows[0]?.dispatchedAt).not.toBeNull();

    const completedEvents = await readSessionEvents(identifiers.session_id);
    const exchangeEvents = completedEvents.filter((event) => event.type === "exchange");
    expect(exchangeEvents).toHaveLength(2);
    expect(exchangeEvents.at(-1)).toMatchObject({
      exId: "ex-durable",
      reply_id: identifiers.reply_id,
      answer: "Durable answer.",
    });

    const replay = await getWithToken(
      `/vaults/${id.vault}/sessions/${identifiers.session_id}`,
    );
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      events: readonly Record<string, unknown>[];
    };
    expect(replayBody.events.filter((event) => event.type === "exchange")).toEqual([
      expect.objectContaining({ exId: "ex-durable", answer: "Durable answer." }),
    ]);

    const markdown = await readFile(
      join(
        currentState().storageRoot,
        "vaults",
        id.vault,
        "sessions",
        `${identifiers.session_id}.md`,
      ),
      "utf8",
    );
    expect(markdown.match(/^# Persist this answer$/gmu)).toHaveLength(1);
  });

  it("replays client-keyed reply acceptance without duplicating work", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [tokenPart("Accepted once."), finishPart("stop", "accepted-once")],
        },
      ],
    });
    await startHarness({ language });

    const replyId = crypto.randomUUID();
    const payload = {
      reply_id: replyId,
      kind: "exchange" as const,
      exchange_id: "ex-accepted-once",
      create: { idempotency_key: "accepted-once-session" },
      question: "Accept this once",
      mode: "query" as const,
      history: [],
    };
    const first = await api(repliesPath, payload);
    const replayed = await api(repliesPath, payload);
    expect(first.response.status).toBe(202);
    expect(replayed.response.status).toBe(202);
    expect(JSON.parse(replayed.text)).toEqual(JSON.parse(first.text));

    const reusedForDifferentRequest = await api(repliesPath, {
      ...payload,
      question: "This is a different request",
    });
    expect(reusedForDifferentRequest.response.status).toBe(409);
    expect(JSON.parse(reusedForDifferentRequest.text)).toMatchObject({
      detail: "Reply id already belongs to another request",
    });

    const identifiers = JSON.parse(first.text) as {
      reply_id: string;
      session_id: string;
    };
    const tail = await tailReply(identifiers.reply_id);
    expect(replySnapshots(tail.text).at(-1)).toMatchObject({
      status: "completed",
      answer: "Accepted once.",
    });
    expect(language.streamCalls).toHaveLength(1);

    const events = (await readSessionEvents(identifiers.session_id)).filter(
      (event) => event.type === "exchange",
    );
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.reply_id)).toEqual([replyId, replyId]);
  });

  it("composes the anchored passage prompt for doc-born sessions while storing the clean question", async () => {
    const language = makeScriptedLanguageModel({
      streams: [{ kind: "parts", parts: [tokenPart("Anchored answer."), finishPart("stop")] }],
    });
    await startHarness({ language });

    const created = await api(repliesPath, {
      kind: "exchange",
      exchange_id: "ex-anchored",
      create: {
        idempotency_key: "anchored-session-key",
        origin_scope: "personal",
        origin: {
          doc_path: "refs/article.md",
          anchor: "the highlighted claim",
          paragraph: "The surrounding passage.",
          paragraph_index: 2,
        },
      },
      question: "What does this claim imply?",
      mode: "btw",
      history: [],
    });
    expect(created.response.status).toBe(202);
    const identifiers = JSON.parse(created.text) as {
      reply_id: string;
      session_id: string;
    };

    const tail = await tailReply(identifiers.reply_id);
    expect(replySnapshots(tail.text).at(-1)).toMatchObject({ status: "completed" });

    // The LLM received the passage/highlight/question composition, mirroring
    // the web client's buildBtwQuery.
    const messages = language.streamCalls[0]?.messages ?? [];
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    expect(lastUser?.content).toBe(
      "Passage:\n> The surrounding passage.\n\nHighlighted: \"the highlighted claim\"\n\nWhat does this claim imply?",
    );

    // The session stores the clean question and the full origin anchor.
    const events = await readSessionEvents(identifiers.session_id);
    expect(events[0]).toMatchObject({
      type: "meta",
      query: "What does this claim imply?",
      origin: {
        doc_path: "refs/article.md",
        origin_scope: "personal",
        anchor: "the highlighted claim",
        paragraph: "The surrounding passage.",
        paragraph_index: 2,
      },
    });
    expect(events[1]).toMatchObject({
      type: "exchange",
      exId: "ex-anchored",
      query: "What does this claim imply?",
    });
    // The composed prompt never persists into the session event log.
    expect(JSON.stringify(events)).not.toContain("Passage:");
    expect(JSON.stringify(events)).not.toContain("Highlighted:");
  });

  it("persists follow-up exchanges and BTW threads through canonical replies", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        { kind: "parts", parts: [tokenPart("First answer."), finishPart("stop")] },
        { kind: "parts", parts: [tokenPart("Follow-up answer."), finishPart("stop")] },
        { kind: "parts", parts: [tokenPart("BTW answer."), finishPart("stop")] },
      ],
    });
    await startHarness({ language });

    const first = await api(repliesPath, {
      kind: "exchange",
      exchange_id: "ex-canonical-first",
      create: { idempotency_key: "canonical-session-key" },
      question: "First question",
      mode: "query",
      history: [],
    });
    expect(first.response.status).toBe(202);
    const firstIds = JSON.parse(first.text) as {
      reply_id: string;
      session_id: string;
    };
    await tailReply(firstIds.reply_id);

    const followUp = await api(repliesPath, {
      kind: "exchange",
      exchange_id: "ex-canonical-follow-up",
      session_id: firstIds.session_id,
      question: "Follow-up question",
      mode: "query",
      history: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer." },
      ],
    });
    expect(followUp.response.status).toBe(202);
    const followUpIds = JSON.parse(followUp.text) as { reply_id: string };
    await tailReply(followUpIds.reply_id);

    const btw = await api(repliesPath, {
      kind: "btw",
      session_id: firstIds.session_id,
      btw: {
        quote: "First answer",
        blockOffset: 0,
        context: "First answer.",
        exchangeId: "ex-canonical-first",
        exchanges: [
          {
            query: "Why this answer?",
            thinking: [],
            answer: "",
          },
        ],
      },
      question: "Why this answer?",
      mode: "btw",
      history: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer." },
      ],
    });
    expect(btw.response.status).toBe(202);
    const btwIds = JSON.parse(btw.text) as { reply_id: string };
    await tailReply(btwIds.reply_id);

    const replay = await getWithToken(`/vaults/${id.vault}/sessions/${firstIds.session_id}`);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      events: readonly Record<string, unknown>[];
    };
    expect(
      replayBody.events
        .filter((event) => event.type === "exchange")
        .map((event) => ({ id: event.exId, answer: event.answer })),
    ).toEqual([
      { id: "ex-canonical-first", answer: "First answer." },
      { id: "ex-canonical-follow-up", answer: "Follow-up answer." },
    ]);
    const btwEvents = replayBody.events.filter((event) => event.type === "btw");
    expect(btwEvents.at(-1)).toMatchObject({
      exId: "ex-canonical-first",
      context: "First answer.",
      exchanges: [{ query: "Why this answer?", answer: "BTW answer." }],
    });

    const markdown = await readFile(
      join(
        currentState().storageRoot,
        "vaults",
        id.vault,
        "sessions",
        `${firstIds.session_id}.md`,
      ),
      "utf8",
    );
    expect(markdown).toContain("# First question");
    expect(markdown).toContain("First answer.");
    expect(markdown).toContain('> **BTW** re: "First answer"');
    expect(markdown).toContain("> BTW answer.");
    expect(markdown).toContain("# Follow-up question");
    expect(markdown).toContain("Follow-up answer.");
  });

  it("reuses an idempotently-created session across reply submissions", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        { kind: "parts", parts: [tokenPart("First"), finishPart("stop", "first")] },
        { kind: "parts", parts: [tokenPart("Second"), finishPart("stop", "second")] },
      ],
    });
    await startHarness({ language });

    const createExchange = async (exchangeId: string, question: string) => {
      const created = await api(repliesPath, {
        kind: "exchange",
        exchange_id: exchangeId,
        create: { idempotency_key: "same-session-key" },
        question,
        mode: "query",
        history: [],
      });
      expect(created.response.status).toBe(202);
      const identifiers = JSON.parse(created.text) as {
        reply_id: string;
        session_id: string;
      };
      await tailReply(identifiers.reply_id);
      return identifiers;
    };

    const first = await createExchange("ex-first", "First question");
    const second = await createExchange("ex-second", "Second question");
    expect(second.session_id).toBe(first.session_id);

    const replay = await getWithToken(`/vaults/${id.vault}/sessions/${first.session_id}`);
    const replayBody = (await replay.json()) as {
      events: readonly Record<string, unknown>[];
    };
    expect(
      replayBody.events
        .filter((event) => event.type === "exchange")
        .map((event) => event.answer),
    ).toEqual(["First", "Second"]);
  });

  it("leaves the pending session event when generation fails", async () => {
    const language = makeScriptedLanguageModel({
      streams: [{ kind: "throw", error: new Error("provider secret") }],
    });
    await startHarness({ language });

    const created = await api(repliesPath, {
      kind: "exchange",
      exchange_id: "ex-failed",
      create: { idempotency_key: "failed-session-key" },
      question: "Fail this answer",
      mode: "query",
      history: [],
    });
    const identifiers = JSON.parse(created.text) as {
      reply_id: string;
      session_id: string;
    };
    const tail = await tailReply(identifiers.reply_id);
    expect(replySnapshots(tail.text).at(-1)).toMatchObject({
      status: "failed",
      error: "Something went wrong while answering. Try again in a minute.",
    });

    const events = await readSessionEvents(identifiers.session_id);
    expect(events.filter((event) => event.type === "exchange")).toEqual([
      expect.objectContaining({
        exId: "ex-failed",
        reply_id: identifiers.reply_id,
        answer: "",
      }),
    ]);
  });

  it("retries a failed reply in place from its persisted request", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [tokenPart("Incomplete answer.")],
          errorAfterParts: new Error("provider secret"),
        },
        {
          kind: "parts",
          parts: [tokenPart("Complete answer."), finishPart("stop", "retry-complete")],
        },
      ],
    });
    await startHarness({ language });

    const created = await api(repliesPath, {
      kind: "exchange",
      exchange_id: "ex-retry",
      create: {
        idempotency_key: "retry-session-key",
        origin_scope: "vault",
        origin: {
          doc_path: "raw/texts/source.md",
          origin_scope: "vault",
          anchor: "The highlighted claim.",
          paragraph: "The surrounding passage.",
          paragraph_index: 3,
        },
      },
      question: "Try this answer",
      mode: "query",
      history: [],
    });
    expect(created.response.status).toBe(202);
    const first = JSON.parse(created.text) as {
      reply_id: string;
      session_id: string;
    };
    const failed = await tailReply(first.reply_id);
    expect(replySnapshots(failed.text).at(-1)).toMatchObject({
      status: "failed",
      answer: "Incomplete answer.",
    });

    const retryId = crypto.randomUUID();
    const retried = await retryReply(first.reply_id, retryId);
    const retryReplay = await retryReply(first.reply_id, retryId);
    expect(retried.response.status).toBe(202);
    expect(retryReplay.response.status).toBe(202);
    expect(JSON.parse(retryReplay.text)).toEqual(JSON.parse(retried.text));
    const second = JSON.parse(retried.text) as {
      reply_id: string;
      session_id: string;
    };
    expect(second.reply_id).toBe(retryId);
    expect(second.session_id).toBe(first.session_id);

    const completed = await tailReply(second.reply_id);
    expect(replySnapshots(completed.text).at(-1)).toMatchObject({
      status: "completed",
      answer: "Complete answer.",
      error: null,
    });
    expect(
      language.streamCalls[1]?.messages.find((message) => message.role === "user"),
    ).toMatchObject({
      role: "user",
      content:
        'Passage:\n> The surrounding passage.\n\nHighlighted: "The highlighted claim."\n\nTry this answer',
    });

    const events = (await readSessionEvents(first.session_id)).filter(
      (event) => event.type === "exchange",
    );
    expect(events).toHaveLength(3);
    expect(events.at(-2)).toMatchObject({
      exId: "ex-retry",
      reply_id: second.reply_id,
      answer: "",
    });
    expect(events.at(-1)).toMatchObject({
      exId: "ex-retry",
      reply_id: second.reply_id,
      answer: "Complete answer.",
    });

    const retryCompleted = await retryReply(second.reply_id);
    expect(retryCompleted.response.status).toBe(400);
    expect(JSON.parse(retryCompleted.text)).toMatchObject({
      detail: "Only failed replies can be retried",
    });
  });

  it("resumes a persisted running reply instead of failing it as a restart zombie", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [tokenPart("Recovered answer."), finishPart("stop", "recovered-generation")],
        },
      ],
    });
    await startHarness({ language });
    const replyId = "00000000-0000-4000-8000-000000020901";

    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(replies)
          .values({
            id: replyId,
            vaultId: id.vault,
            userId: id.alice,
            kind: "ephemeral",
            status: "running",
            answer: "partial",
            sources: [],
            request: {
              reply_id: replyId,
              kind: "ephemeral",
              question: "resume after restart",
              mode: "query",
              history: [],
            },
            createdAt: initialTime,
            updatedAt: initialTime,
          }))
          .pipe(Effect.orDie);
        const service = yield* RepliesService;
        expect(yield* service.reconcileOnce()).toBe(1);
      }),
    );
    const tail = await tailReply(replyId);
    expect(replySnapshots(tail.text).at(-1)).toMatchObject({ status: "completed" });

    const rows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d.select().from(replies).where(eq(replies.id, replyId))).pipe(Effect.orDie);
      }),
    );
    expect(rows[0]).toMatchObject({
      status: "completed",
      error: null,
      answer: "Recovered answer.",
      dispatchedTaskId: replyId,
    });
    expect(rows[0]?.dispatchedAt).not.toBeNull();
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

    const { response, text, snapshots } = await runReply({
      question: "Explain value.",
      history: [],
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(text).toContain("event: connected\n");
    expect(text).toContain("event: done\n");
    expect(snapshots.at(-1)).toMatchObject({
      status: "completed",
      answer: "Answer.",
      error: null,
      sources: [
        { type: "query", label: "contains: Alpha, sort: central" },
        { type: "query", label: "tags: theory, author: Lenin" },
        { type: "search", label: "capital", scope: "kb" },
        {
          type: "search",
          label: "value",
          scope: "kb",
          path: "raw/texts/source.md",
          title: "Raw Source",
        },
        // Links resolves into its pending slot in place; article/raw
        // resolutions re-push at the end (read+expand collapse to one card).
        { type: "links", label: "wiki/alpha.md", title: "Alpha" },
        { type: "article", label: "wiki/alpha.md", title: "Alpha", full: true },
        {
          type: "raw",
          label: "raw/texts/source.md",
          title: "Raw Source",
          full: true,
          ranges: [{ start: 0, end: 1 }],
        },
      ],
    });

    const systemMessage = language.streamCalls[0]?.messages[0];
    if (typeof systemMessage?.content !== "string") throw new Error("system prompt missing");
    const systemPromptHash = promptContentHash(systemMessage.content);
    const replyId = snapshots.at(-1)?.reply_id;
    if (replyId === undefined) throw new Error("reply id missing");
    const recorded = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return {
          events: yield* db.query((d) => d.select().from(llmCostEvents)).pipe(Effect.orDie),
          prompts: yield* db.query((d) =>
            d.select().from(prompts).where(eq(prompts.hash, systemPromptHash))).pipe(Effect.orDie),
          reply: yield* db.query((d) => d.select().from(replies).where(eq(replies.id, replyId)))
            .pipe(Effect.orDie),
        };
      }),
    );
    expect(recorded.events).toHaveLength(1);
    expect(recorded.events[0]).toMatchObject({
      eventType: "query.stream",
      costUsd: "0.060000",
      model: "primary/test-model",
      promptHash: systemPromptHash,
    });
    expect(recorded.prompts).toEqual([
      expect.objectContaining({ hash: systemPromptHash, content: systemMessage.content }),
    ]);
    expect(recorded.reply[0]).toMatchObject({
      status: "completed",
      generationCursor: 11,
      activeGenerationStep: null,
      activeGenerationKind: null,
      activeGenerationKey: null,
    });
    await expect(
      readFile(
        join(currentState().storageRoot, "vaults", id.vault, "operations", "replies", `${replyId}.json`),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(promptContentHash(recorded.prompts[0]!.content)).toBe(recorded.prompts[0]!.hash);
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

    await runReply({
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
    await runReply({
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
      streams: [
        { kind: "parts", parts: [tokenPart("A"), finishPart("stop", "origin-frontmatter")] },
      ],
    });
    await startHarness({ language });

    await runReply({
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
        yield* db.query((d) => d.delete(searchIndex)).pipe(Effect.orDie);
        yield* db.query((d) => d
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
          ]))
          .pipe(Effect.orDie);
      }),
    );

    const { snapshots } = await runReply({ question: "Find dual power" });

    expect(snapshots.at(-1)?.sources).toContainEqual(
      expect.objectContaining({ type: "search", label: "dual power", scope: "kb" }),
    );
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
    await runReply({ question: "Can you use the web?" });
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
    await runReply({ question: "Can config enable web without key?" });
    expect(
      missingParallelLanguage.streamCalls[0].tools.map((tool) => tool.function.name),
    ).not.toContain("web_search");
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
          text:
            "```json\n" +
            JSON.stringify({ results: [{ index: 1, facts: ["Fact one"] }] }) +
            "\n```",
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

    const { snapshots } = await runReply({ question: "Need current facts" });
    expect(onLanguage.streamCalls[0].tools.map((tool) => tool.function.name)).toContain(
      "web_search",
    );
    expect(String(onLanguage.streamCalls[0].messages[0].content)).toContain("WEB SEARCH");
    expect(parallel.calls).toEqual([
      { question: "Need current facts", query: "recent factual query" },
    ]);
    expect(onLanguage.completeCalls[0].model).toBe("extract/test-model");
    expect(snapshots.at(-1)?.sources).toContainEqual(
      expect.objectContaining({
        type: "search",
        label: "recent factual query",
        scope: "web",
      }),
    );
    expect(snapshots.at(-1)?.status).toBe("completed");
  });

  it("persists sanitized setup and mid-loop failures", async () => {
    const setupLanguage = makeScriptedLanguageModel({ streams: [] });
    await startHarness({ language: setupLanguage });
    await writeVaultFile(id.vault, "config.yaml", ": bad: [");
    const setup = await runReply({ question: "break setup" });
    expect(setup.snapshots.at(-1)).toMatchObject({
      status: "failed",
      error: "Something went wrong while answering. Try again in a minute.",
    });
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
        {
          kind: "parts",
          parts: [tokenPart("Partial answer that may be incomplete.")],
          errorAfterParts: new Error("secret provider detail"),
        },
      ],
    });
    await startHarness({ language: loopLanguage });
    const loop = await runReply({ question: "break loop" });
    expect(loop.snapshots.at(-1)).toMatchObject({
      status: "failed",
      answer: "Partial answer that may be incomplete.",
      error: "Something went wrong while answering. Try again in a minute.",
      sources: [{ type: "query", label: "contains: Alpha" }],
    });
    expect(loop.text).not.toContain("secret provider detail");
    expect(loop.text).toContain("event: done\n");
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

    const malformed = await runReply({ question: "break tool args" });

    expect(malformed.snapshots.at(-1)).toMatchObject({
      status: "failed",
      error: "Malformed tool args for search_content",
    });
    expect(malformed.text).toContain("event: done\n");
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

    const result = await runReply({ question: "missing source" });

    expect(result.snapshots.at(-1)).toMatchObject({
      status: "completed",
      answer: "Recovered",
      sources: [],
    });
  });

  it("returns invalid tool arguments to the model as tool messages instead of failing the reply", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [
            toolCallPart(0, "tc-list", "list_articles", { contains: "Alpha", sort: "bogus" }),
            toolCallPart(1, "tc-expand", "expand_context", {
              path: "wiki/alpha.md",
              start: "zero",
              end: 2,
            }),
            finishPart("tool_calls", "bad-args-round"),
          ],
        },
        { kind: "parts", parts: [tokenPart("Recovered"), finishPart("stop", "bad-args-final")] },
      ],
    });
    await startHarness({ language });

    const result = await runReply({ question: "bad args" });

    expect(result.snapshots.at(-1)).toMatchObject({
      status: "completed",
      answer: "Recovered",
      sources: [],
    });
    const secondRound = language.streamCalls[1]!.messages;
    expect(secondRound).toContainEqual({
      role: "tool",
      tool_call_id: "tc-list",
      content: "Invalid list_articles sort: bogus (expected recent, alpha, or central)",
    });
    expect(secondRound).toContainEqual({
      role: "tool",
      tool_call_id: "tc-expand",
      content: "Tool argument start must be an integer",
    });
  });

  it("treats non-object tool arguments as malformed", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [
            malformedToolCallPart(0, "tc-array", "search_content", '["Alpha"]'),
            finishPart("tool_calls", "array-args-round"),
          ],
        },
      ],
    });
    await startHarness({ language });

    const result = await runReply({ question: "array args" });

    expect(result.snapshots.at(-1)).toMatchObject({
      status: "failed",
      error: "Malformed tool args for search_content",
    });
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

    await runReply({ question: "genre" });

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

    const { snapshots } = await runReply({ question: "fallback please" });

    expect(language.streamCalls.map((call) => call.model)).toEqual([
      "primary/test-model",
      "fallback/test-model",
    ]);
    expect(snapshots.at(-1)).toMatchObject({ status: "completed", answer: "Fallback" });
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

    const { snapshots } = await runReply({ question: "cost fallback" });

    expect(snapshots.at(-1)).toMatchObject({ status: "completed", answer: "Lookup" });
    expect(costs.lookups).toEqual(["lookup-gen"]);
    const rows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d.select().from(llmCostEvents)).pipe(Effect.orDie);
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

    const { snapshots } = await runReply({ question: "zero cost" });

    expect(snapshots.at(-1)).toMatchObject({ status: "completed", answer: "Free" });
    expect(costs.lookups).toEqual([]);
    const rows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d.select().from(llmCostEvents)).pipe(Effect.orDie);
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
    expect(JSON.parse(bad.text)).toMatchObject({ detail: "description required" });
  });

  it("returns draft-hint 503 before blank-description validation when the LLM key is missing", async () => {
    const language = makeScriptedLanguageModel({ completions: [], hasApiKey: false });
    await startHarness({
      language,
      configOverrides: { openRouterApiKey: Option.none() },
    });

    const response = await api("/vaults/draft-hint", { description: "   " });

    expect(response.response.status).toBe(503);
    expect(JSON.parse(response.text)).toMatchObject({
      detail: "LLM service not configured (OPENROUTER_API_KEY missing)",
    });
    expect(language.completeCalls).toHaveLength(0);
  });

  it.skipIf(process.env.RUN_LIVE_LLM_SMOKE !== "1")(
    "completes a live one-round OpenRouter smoke and records cost",
    async () => {
      await startLiveHarness();

      const { response, snapshots } = await runReply({
        question:
          "Use list_articles first to orient on Alpha, then answer in one short sentence with a citation.",
      });

      expect(response.status).toBe(200);
      expect(snapshots.at(-1)?.status).toBe("completed");
      expect(snapshots.at(-1)?.sources.length).toBeGreaterThan(0);
      expect(snapshots.at(-1)?.answer.length).toBeGreaterThan(0);
      const rows = await runDb(
        Effect.gen(function* () {
          const db = yield* Database;
          return yield* db.query((d) => d.select().from(llmCostEvents)).pipe(Effect.orDie);
        }),
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(Number(rows[0].costUsd)).toBeGreaterThan(0);
    },
  );
});
