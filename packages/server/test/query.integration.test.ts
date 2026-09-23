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
import { type OriginSessionDetail, Uuid } from "@great-minds/domain";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeAppLayer } from "../src/app-layer.ts";
import { ClockService, makeTestClock } from "../src/clock.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { promptContentHash } from "../src/crypto.ts";
import { StructuredLogger, StructuredLoggerLive } from "../src/logging.ts";
import { type LlmAssistantToolCall, type LlmMessage, type ModelStreamPart } from "../src/llm.ts";
import { ParallelSearchService } from "../src/parallel.ts";
import { makeTestMailer } from "../src/mailer.ts";
import { RepliesService } from "../src/replies.ts";
import { startServer } from "../src/server.ts";
import { SessionsService, type ReplyNode, type StoredSessionEvent } from "../src/sessions.ts";
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
const uuid = Schema.decodeUnknownSync(Uuid);

const id = {
  alice: uuid("00000000-0000-4000-8000-000000020001"),
  bob: uuid("00000000-0000-4000-8000-000000020002"),
  vault: uuid("00000000-0000-4000-8000-000000020101"),
  topicAlpha: uuid("00000000-0000-4000-8000-000000020301"),
  topicBeta: uuid("00000000-0000-4000-8000-000000020302"),
  articleAlpha: uuid("00000000-0000-4000-8000-000000020401"),
  articleBeta: uuid("00000000-0000-4000-8000-000000020402"),
  source: uuid("00000000-0000-4000-8000-000000020501"),
} as const;

const EX_DURABLE = "00000000-0000-4000-8000-000000000301";
const EX_ACCEPTED_ONCE = "00000000-0000-4000-8000-000000000302";
const EX_ANCHORED = "00000000-0000-4000-8000-000000000303";
const EX_CANONICAL_FIRST = "00000000-0000-4000-8000-000000000304";
const EX_CANONICAL_FOLLOW_UP = "00000000-0000-4000-8000-000000000305";
const EX_CANONICAL_BTW_1 = "00000000-0000-4000-8000-000000000306";
const EX_GUARD = "00000000-0000-4000-8000-000000000307";
const EX_FIRST = "00000000-0000-4000-8000-000000000308";
const EX_SECOND = "00000000-0000-4000-8000-000000000309";
const EX_FAILED = "00000000-0000-4000-8000-00000000030a";
const EX_RETRY = "00000000-0000-4000-8000-00000000030b";
const EX_VERBATIM_1 = "00000000-0000-4000-8000-00000000030c";
const EX_VERBATIM_2 = "00000000-0000-4000-8000-00000000030d";
const EX_VERBATIM_3 = "00000000-0000-4000-8000-00000000030e";
const EX_BRANCH_PARENT = "00000000-0000-4000-8000-00000000030f";
const EX_BRANCH_BTW_1 = "00000000-0000-4000-8000-000000000310";
const EX_BRANCH_BTW_2 = "00000000-0000-4000-8000-000000000311";
const EX_BRANCH_FOLLOW_UP = "00000000-0000-4000-8000-000000000312";
const EX_ORIGIN_ROOT = "00000000-0000-4000-8000-000000000313";
const EX_ORIGIN_DOC = "00000000-0000-4000-8000-000000000314";
const EX_ORIGIN_THIRD = "00000000-0000-4000-8000-000000000315";
const EX_CHAIN_1 = "00000000-0000-4000-8000-000000000316";
const EX_CHAIN_2 = "00000000-0000-4000-8000-000000000317";
const EX_CHAIN_3 = "00000000-0000-4000-8000-000000000318";

type TestServices =
  | AppConfig
  | Database
  | ClockService
  | RepliesService
  | SessionsService
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

const issueToken = (userId: Uuid) =>
  runDb(
    Effect.gen(function* () {
      const tokens = yield* TokenService;
      return yield* tokens.issueAccessToken(userId, initialTime);
    }),
  );

const insertUser = (userId: Uuid, email: string) =>
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
          id: uuid("00000000-0000-4000-8000-000000020701"),
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
  readonly status: "running" | "completed" | "failed" | "stopped";
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
    mode: "query",
    exchange_id: crypto.randomUUID(),
    session: { kind: "new", idempotency_key: crypto.randomUUID() },
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
    .map((line) => JSON.parse(line) as StoredSessionEvent);
};

const getWithToken = (path: string) =>
  fetch(`${currentState().started.url}/v1${path}`, {
    headers: { authorization: `Bearer ${currentState().token}` },
  });

type OriginReadHit = {
  readonly index: number;
  readonly call: LlmAssistantToolCall;
};

const originReadHits = (messages: readonly LlmMessage[]): readonly OriginReadHit[] => {
  const hits: OriginReadHit[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const call of message.tool_calls ?? []) {
      if (call.function.name === "read_document") {
        hits.push({ index, call });
      }
    }
  }
  return hits;
};

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
  it("persists a stop before preparation without starting a model request", async () => {
    const language = makeScriptedLanguageModel({ streams: [] });
    await startHarness({ language });
    const replyId = uuid(crypto.randomUUID());
    const exchangeId = uuid(crypto.randomUUID());
    const sessionId = await runDb(Effect.gen(function* () {
      const service = yield* SessionsService;
      const db = yield* Database;
      const sessionId = yield* service.createSession(id.alice, id.vault, {
        idempotencyKey: crypto.randomUUID(),
        pending: { replyId, exchangeId, question: "Stop before work starts" },
      });
      yield* db.query((d) => d.insert(replies).values({
        id: replyId, userId: id.alice, vaultId: id.vault, sessionId,
        kind: "exchange", status: "running", dispatchedAt: initialTime,
        request: { reply_id: replyId, exchange_id: exchangeId, question: "Stop before work starts", mode: "query", session: { kind: "existing", id: sessionId } },
      }));
      return sessionId;
    }));
    expect((await api(`${repliesPath}/${replyId}/stop`, {})).response.status).toBe(204);
    await runDb(Effect.gen(function* () {
      const service = yield* RepliesService;
      expect(yield* service.prepareStep(replyId)).toMatchObject({ outcome: "stopped" });
      yield* service.finalizeStep(replyId, "stopped", null);
    }));
    expect(replySnapshots((await tailReply(replyId)).text).at(-1)).toMatchObject({ status: "stopped", answer: "", error: null });
    expect((await readSessionEvents(sessionId)).at(-1)).toMatchObject({
      status: "stopped", messages: [{ role: "user", content: "Stop before work starts" }],
    });
    expect(language.streamCalls).toHaveLength(0);
  });

  it.each(["Partial answer.", ""])("stops a pending model response with %j, saves it, and follows up in the same conversation", async (answer) => {
    let close!: (result: IteratorResult<ModelStreamPart>) => void;
    const closed = new Promise<IteratorResult<ModelStreamPart>>((resolve) => { close = resolve; });
    let sent = false;
    const language = makeScriptedLanguageModel({ streams: [
      { kind: "stream", stream: {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (!sent && answer) {
              sent = true;
              return Promise.resolve({ done: false as const, value: tokenPart(answer) });
            }
            return closed;
          },
          return: () => {
            close({ done: true, value: undefined });
            return closed;
          },
        }),
      } },
      { kind: "parts", parts: [tokenPart("A follow-up answer."), finishPart("stop")] },
    ] });
    await startHarness({ language });
    const created = await api(repliesPath, {
      exchange_id: crypto.randomUUID(), question: "A question to stop", mode: "query",
      session: { kind: "new", idempotency_key: crypto.randomUUID() },
    });
    const ids = JSON.parse(created.text) as { reply_id: string; session_id: string };
    await vi.waitFor(async () => {
      const rows = await runDb(Effect.flatMap(Database, (db) => db.query((d) => d.select().from(replies)
        .where(eq(replies.id, uuid(ids.reply_id))))));
      expect(rows[0].answer).toBe(answer);
      expect(language.streamCalls).toHaveLength(1);
    }, { timeout: 10_000 });
    const stopped = await api(`${repliesPath}/${ids.reply_id}/stop`, {});
    expect(stopped.response.status).toBe(204);
    const tail = await tailReply(ids.reply_id);
    expect(replySnapshots(tail.text).at(-1)).toMatchObject({ status: "stopped", answer, error: null });
    expect(await closed).toEqual({ done: true, value: undefined });
    expect((await api(`${repliesPath}/${ids.reply_id}/stop`, {})).response.status).toBe(204);
    const nodes = (await readSessionEvents(ids.session_id)).filter((event) => event.type === "reply");
    expect(nodes).toHaveLength(2);
    expect(nodes.at(-1)).toMatchObject({ status: "stopped", answer });
    const reloaded = await getWithToken(`/vaults/${id.vault}/sessions/${ids.session_id}`);
    expect(await reloaded.json()).toMatchObject({ events: expect.arrayContaining([
      expect.objectContaining({ type: "exchange", answer, stopped: true }),
    ]) });
    const followUp = await runReply({ question: "Continue from there", session: { kind: "existing", id: ids.session_id } });
    expect(followUp.snapshots.at(-1)?.status).toBe("completed");
    expect(language.streamCalls).toHaveLength(2);
    expect(language.streamCalls[1].messages).toEqual(expect.arrayContaining([
      { role: "user", content: "A question to stop" },
      ...(answer ? [{ role: "assistant", content: answer }] : []),
      { role: "user", content: "Continue from there" },
    ]));
    expect((await readSessionEvents(ids.session_id)).filter((event) => event.type === "reply").at(-1))
      .toMatchObject({ parent_reply_id: ids.reply_id });
  });

  it.each(["search", "extraction"])("stops active web %s and preserves a valid transcript for the next model call", async (stage) => {
    let toolStarted = false;
    let toolStopped = false;
    const pending = Effect.sync(() => { toolStarted = true; }).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => { toolStopped = true; })),
    );
    const language = makeScriptedLanguageModel({ streams: [
      { kind: "parts", parts: [
        tokenPart("Looking for sources."),
        toolCallPart(0, "read-first", "read_document", { path: "wiki/alpha.md" }),
        toolCallPart(1, "search-pending", "web_search", { query: "capital" }),
        finishPart("tool_calls"),
      ] },
      { kind: "parts", parts: [tokenPart("Continuing after the stop."), finishPart("stop")] },
    ], completions: [pending] });
    await startHarness({ language, parallelLayer: Layer.succeed(ParallelSearchService, {
      hasApiKey: true,
      search: () => stage === "search" ? pending : Effect.succeed([
        { title: "External result", url: "https://example.test/result", excerpts: ["A fact about capital."] },
      ]),
    }) });
    await writeVaultFile(id.vault, "config.yaml", "name: Query Vault\nweb_search: true\n");
    const created = await api(repliesPath, {
      exchange_id: crypto.randomUUID(), question: "Research capital", mode: "query",
      session: { kind: "new", idempotency_key: crypto.randomUUID() },
    });
    const ids = JSON.parse(created.text) as { reply_id: string; session_id: string };
    await vi.waitFor(() => expect(toolStarted).toBe(true), { timeout: 10_000 });
    expect((await api(`${repliesPath}/${ids.reply_id}/stop`, {})).response.status).toBe(204);
    expect(replySnapshots((await tailReply(ids.reply_id)).text).at(-1)).toMatchObject({ status: "stopped" });
    expect(toolStopped).toBe(true);
    expect(language.completeCalls).toHaveLength(stage === "extraction" ? 1 : 0);
    const node = (await readSessionEvents(ids.session_id)).filter((event) => event.type === "reply").at(-1)!;
    expect(node.sources).toEqual(expect.not.arrayContaining([expect.objectContaining({ pending: true })]));
    expect(node.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "read-first", content: expect.stringContaining("Alpha article body") }),
      { role: "tool", tool_call_id: "search-pending", content: "Tool call cancelled because the user stopped the response." },
    ]));
    const followUp = await runReply({ question: "Use what you have", session: { kind: "existing", id: ids.session_id } });
    expect(followUp.snapshots.at(-1)?.status).toBe("completed");
    expect(language.streamCalls).toHaveLength(2);
    expect(language.streamCalls[1].messages).toEqual(expect.arrayContaining([...node.messages]));
  });

  it("keeps completed replies unchanged and restricts stopping to the reply owner", async () => {
    const language = makeScriptedLanguageModel({ streams: [
      { kind: "parts", parts: [tokenPart("Finished."), finishPart("stop")] },
    ] });
    await startHarness({ language });
    const result = await runReply({ question: "A short question" });
    const replyId = result.snapshots.at(-1)!.reply_id;
    expect((await api(`${repliesPath}/${replyId}/stop`, {})).response.status).toBe(204);
    expect(replySnapshots((await tailReply(replyId)).text).at(-1)).toMatchObject({ status: "completed", answer: "Finished." });
    await runDb(Effect.gen(function* () {
      const db = yield* Database;
      const service = yield* RepliesService;
      yield* db.query((d) => d.update(replies).set({ status: "running", stopRequested: true })
        .where(eq(replies.id, uuid(replyId))));
      yield* service.finalizeStep(uuid(replyId), "stopped", null);
    }));
    expect(replySnapshots((await tailReply(replyId)).text).at(-1)).toMatchObject({ status: "completed", answer: "Finished." });
    expect((await api(`${repliesPath}/${crypto.randomUUID()}/stop`, {})).response.status).toBe(404);
    await insertUser(id.bob, "stop-bob@example.com");
    await runDb(Effect.flatMap(Database, (db) => db.query((d) => d.insert(vaultMemberships)
      .values({ id: uuid(crypto.randomUUID()), vaultId: id.vault, userId: id.bob, role: "VIEWER" }))));
    const forbidden = await apiWithToken(`${repliesPath}/${replyId}/stop`, {}, await issueToken(id.bob));
    expect(forbidden.response.status).toBe(404);
    expect(language.streamCalls).toHaveLength(1);
  });

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
      {
        mode: "query",
        question: "No access",
        exchange_id: crypto.randomUUID(),
        session: { kind: "new", idempotency_key: crypto.randomUUID() },
      },
      bobToken,
    );
    expect(nonMember.response.status).toBe(403);
    expect(nonMember.response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    expect(JSON.parse(nonMember.text)).toMatchObject({
      detail: "Only vault members can perform this action",
    });

    const unknown = await api("/vaults/00000000-0000-4000-8000-000000029999/replies", {
      mode: "query",
      question: "Missing",
      exchange_id: crypto.randomUUID(),
      session: { kind: "new", idempotency_key: crypto.randomUUID() },
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
      mode: "query",
      question: "No key",
      exchange_id: crypto.randomUUID(),
      session: { kind: "new", idempotency_key: crypto.randomUUID() },
    });
    expect(noKey.response.status).toBe(503);
    expect(noKey.response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    expect(JSON.parse(noKey.text)).toMatchObject({
      detail: "LLM service not configured (OPENROUTER_API_KEY missing)",
    });
    expect(noKeyLanguage.streamCalls).toHaveLength(0);
  });

  it("rejects missing or malformed session destinations before generating a reply", async () => {
    const language = makeScriptedLanguageModel({ streams: [] });
    await startHarness({ language });
    for (const destination of [
      {},
      { kind: "ephemeral" },
      { session: { kind: "existing" } },
      { session: { kind: "new" } },
      { session: { kind: "new", idempotency_key: "incomplete-anchor", conversation_kind: "btw", origin: { kind: "answer", anchor: "incomplete anchor" } } },
    ]) {
      const result = await api(repliesPath, {
        exchange_id: crypto.randomUUID(),
        question: "Why?",
        ...destination,
      });
      expect(result.response.status).toBe(422);
    }
    expect(language.streamCalls).toHaveLength(0);
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
      exchange_id: EX_DURABLE,
      question: "Persist this answer",
      mode: "query",
      session: {
        kind: "new",
        idempotency_key: "reply-session-idempotency",
        origin: {
          kind: "document",
          doc_path: "wiki/alpha.md",
          origin_scope: "vault",
          anchor: null,
          paragraph: null,
          paragraph_index: null,
        },
      },
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
          event.type === "reply" &&
          event.exchange_id === EX_DURABLE &&
          event.status === "pending" &&
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
          .where(eq(replies.id, uuid(identifiers.reply_id))))
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
    const replyEvents = completedEvents.filter((event) => event.type === "reply");
    expect(replyEvents).toHaveLength(2);
    expect(replyEvents.at(-1)).toMatchObject({
      type: "reply",
      exchange_id: EX_DURABLE,
      reply_id: identifiers.reply_id,
      status: "completed",
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
      expect.objectContaining({ exId: EX_DURABLE, answer: "Durable answer." }),
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
      exchange_id: EX_ACCEPTED_ONCE,
      question: "Accept this once",
      mode: "query" as const,
      session: { kind: "new", idempotency_key: "accepted-once-session" },
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
      (event) => event.type === "reply",
    );
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.reply_id)).toEqual([replyId, replyId]);
    expect(events.map((event) => event.status)).toEqual(["pending", "completed"]);
  });

  it("composes the anchored passage prompt for doc-born sessions while storing the clean question", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        { kind: "parts", parts: [tokenPart("Anchored answer."), finishPart("stop")] },
        { kind: "parts", parts: [tokenPart("Follow-up answer."), finishPart("stop")] },
      ],
    });
    await startHarness({ language });

    const created = await api(repliesPath, {
      exchange_id: EX_ANCHORED,
      question: "What does this claim imply?",
      mode: "btw",
      session: {
        kind: "new",
        idempotency_key: "anchored-session-key",
        conversation_kind: "btw",
        origin_scope: "personal",
        origin: {
          kind: "document",
          doc_path: "refs/article.md",
          origin_scope: "personal",
          anchor: "the highlighted claim",
          paragraph: "The surrounding passage.",
          paragraph_index: 2,
        },
      },
    });
    expect(created.response.status).toBe(202);
    const identifiers = JSON.parse(created.text) as {
      reply_id: string;
      session_id: string;
    };

    const tail = await tailReply(identifiers.reply_id);
    expect(replySnapshots(tail.text).at(-1)).toMatchObject({ status: "completed" });

    // The LLM received the passage/highlight/question composition.
    const messages = language.streamCalls[0]?.messages ?? [];
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    expect(lastUser?.content).toBe(
      "Passage:\n> The surrounding passage.\n\nHighlighted: \"the highlighted claim\"\n\nWhat does this claim imply?",
    );

    const events = await readSessionEvents(identifiers.session_id);
    expect(events[0]).toMatchObject({
      type: "meta",
      query: "What does this claim imply?",
      origin: {
        kind: "document",
        doc_path: "refs/article.md",
        origin_scope: "personal",
        anchor: "the highlighted claim",
        paragraph: "The surrounding passage.",
        paragraph_index: 2,
      },
    });
    const pendingNode = events.find(
      (event): event is ReplyNode =>
        event.type === "reply" &&
        event.exchange_id === EX_ANCHORED &&
        event.status === "pending",
    );
    const completedNode = events.find(
      (event): event is ReplyNode =>
        event.type === "reply" &&
        event.exchange_id === EX_ANCHORED &&
        event.status === "completed",
    );
    expect(pendingNode).toMatchObject({
      question: "What does this claim imply?",
    });
    expect(completedNode).toMatchObject({
      question: "What does this claim imply?",
      answer: "Anchored answer.",
    });
    expect(completedNode?.messages?.[0]).toMatchObject({
      role: "user",
      content:
        'Passage:\n> The surrounding passage.\n\nHighlighted: "the highlighted claim"\n\nWhat does this claim imply?',
    });
    const followUp = await runReply({
      question: "What follows?",
      mode: "btw",
      session: { kind: "existing", id: identifiers.session_id },
    });
    expect(followUp.snapshots.at(-1)).toMatchObject({ status: "completed" });
    expect(language.streamCalls[1]?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)).toEqual([
        'Passage:\n> The surrounding passage.\n\nHighlighted: "the highlighted claim"\n\nWhat does this claim imply?',
        "What follows?",
      ]);
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
      exchange_id: EX_CANONICAL_FIRST,
      question: "First question",
      mode: "query",
      session: { kind: "new", idempotency_key: "canonical-session-key" },
    });
    expect(first.response.status).toBe(202);
    const firstIds = JSON.parse(first.text) as {
      reply_id: string;
      session_id: string;
    };
    await tailReply(firstIds.reply_id);

    const followUp = await api(repliesPath, {
      exchange_id: EX_CANONICAL_FOLLOW_UP,
      question: "Follow-up question",
      mode: "query",
      session: { kind: "existing", id: firstIds.session_id },
    });
    expect(followUp.response.status).toBe(202);
    const followUpIds = JSON.parse(followUp.text) as { reply_id: string };
    await tailReply(followUpIds.reply_id);

    const btw = await api(repliesPath, {
      exchange_id: EX_CANONICAL_BTW_1,
      question: "Why this answer?",
      mode: "btw",
      session: {
        kind: "new",
        conversation_kind: "btw",
        idempotency_key: "canonical-btw",
        origin: {
          kind: "answer",
          session_id: firstIds.session_id,
          anchor: "First answer",
          paragraph_index: 0,
          paragraph: "First answer.",
          exchange_id: EX_CANONICAL_FIRST,
        },
      },
    });
    expect(btw.response.status).toBe(202);
    const btwIds = JSON.parse(btw.text) as { reply_id: string; session_id: string };
    expect(btwIds.session_id).not.toBe(firstIds.session_id);
    await tailReply(btwIds.reply_id);

    const replay = await getWithToken(`/vaults/${id.vault}/sessions/${firstIds.session_id}`);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      events: readonly Record<string, unknown>[];
      threads: readonly OriginSessionDetail[];
    };
    expect(
      replayBody.events
        .filter((event) => event.type === "exchange")
        .map((event) => ({ id: event.exId, answer: event.answer })),
    ).toEqual([
      { id: EX_CANONICAL_FIRST, answer: "First answer." },
      { id: EX_CANONICAL_FOLLOW_UP, answer: "Follow-up answer." },
    ]);
    expect(replayBody.threads[0]?.session).toMatchObject({
      id: btwIds.session_id,
      kind: "btw",
      origin: { kind: "answer", exchange_id: EX_CANONICAL_FIRST, paragraph: "First answer." },
    });
    expect(replayBody.threads[0]?.events).toContainEqual(expect.objectContaining({ exId: EX_CANONICAL_BTW_1, query: "Why this answer?", answer: "BTW answer." }));
    expect(language.streamCalls[2]?.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "First question", "Follow-up question", 'Passage:\n> First answer.\n\nHighlighted: "First answer"\n\nWhy this answer?',
    ]);

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
    expect(markdown).not.toContain("BTW answer.");
    expect(markdown).toContain("# Follow-up question");
    expect(markdown).toContain("Follow-up answer.");
  });

  it("rejects exchange ids outside the path charset on session-bound replies", async () => {
    const language = makeScriptedLanguageModel({
      streams: [{ kind: "parts", parts: [tokenPart("First answer."), finishPart("stop")] }],
    });
    await startHarness({ language });
    const first = await api(repliesPath, {
      exchange_id: EX_GUARD,
      question: "First question",
      mode: "query",
      session: { kind: "new", idempotency_key: "guard-session-key" },
    });
    expect(first.response.status).toBe(202);
    const { session_id } = JSON.parse(first.text) as { session_id: string };

    const btwTraversal = await api(repliesPath, {
      exchange_id: "../../wiki/index",
      question: "Why?",
      mode: "query",
      session: {
        kind: "new",
        conversation_kind: "btw",
        idempotency_key: "invalid-btw-anchor",
        origin: {
          kind: "answer",
          session_id,
          anchor: "First",
          paragraph_index: 0,
          paragraph: "First answer.",
          exchange_id: "../../wiki/index",
        },
      },
    });
    expect(btwTraversal.response.status).toBe(422);

    const traversal = await api(repliesPath, {
      exchange_id: "../../wiki/index",
      question: "Second question",
      mode: "query",
      session: { kind: "existing", id: session_id },
    });
    expect(traversal.response.status).toBe(422);
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
        exchange_id: exchangeId,
        question,
        mode: "query",
        session: { kind: "new", idempotency_key: "same-session-key" },
      });
      expect(created.response.status).toBe(202);
      const identifiers = JSON.parse(created.text) as {
        reply_id: string;
        session_id: string;
      };
      await tailReply(identifiers.reply_id);
      return identifiers;
    };

    const first = await createExchange(EX_FIRST, "First question");
    const second = await createExchange(EX_SECOND, "Second question");
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
      exchange_id: EX_FAILED,
      question: "Fail this answer",
      mode: "query",
      session: { kind: "new", idempotency_key: "failed-session-key" },
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
    expect(events.filter((event) => event.type === "reply")).toEqual([
      expect.objectContaining({
        exchange_id: EX_FAILED,
        reply_id: identifiers.reply_id,
        status: "pending",
        answer: "",
      }),
    ]);
  });

  it.each(["query", "btw"])("retries a failed document reply in place with an existing session in %s mode", async (mode) => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [tokenPart("Incomplete answer.")],
          errorAfterParts: new Error("provider secret"),
        },
        {
          kind: "parts",
          parts: [tokenPart("A later answer."), finishPart("stop", "later-answer")],
        },
        {
          kind: "parts",
          parts: [tokenPart("Complete answer."), finishPart("stop", "retry-complete")],
        },
      ],
    });
    await startHarness({ language });

    const created = await api(repliesPath, {
      exchange_id: EX_RETRY,
      question: "Try this answer",
      mode,
      session: {
        kind: "new",
        idempotency_key: "retry-session-key",
        origin_scope: "vault",
        origin: {
          kind: "document",
          doc_path: "raw/texts/source.md",
          origin_scope: "vault",
          anchor: "The highlighted claim.",
          paragraph: "The surrounding passage.",
          paragraph_index: 3,
        },
      },
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

    const later = await runReply({
      question: "A later question",
      session: { kind: "existing", id: first.session_id },
    });
    expect(later.snapshots.at(-1)).toMatchObject({ status: "completed" });

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
      language.streamCalls[2]?.messages.find((message) => message.role === "user"),
    ).toMatchObject({
      role: "user",
      content:
        'Passage:\n> The surrounding passage.\n\nHighlighted: "The highlighted claim."\n\nTry this answer',
    });
    expect(JSON.stringify(language.streamCalls[2]?.messages)).not.toContain("A later question");
    const retriedRows = await runDb(Effect.gen(function* () {
      const db = yield* Database;
      return yield* db.query((d) => d.select().from(replies).where(eq(replies.id, uuid(retryId))));
    }));
    expect(retriedRows[0]?.request).toMatchObject({
      exchange_id: EX_RETRY,
      session: { kind: "existing", id: first.session_id },
      mode,
    });
    expect(JSON.stringify(retriedRows[0]?.request)).not.toContain("The highlighted claim.");

    const events = (await readSessionEvents(first.session_id)).filter(
      (event) => event.type === "reply",
    );
    expect(events).toHaveLength(5);
    expect(events.at(-2)).toMatchObject({
      type: "reply",
      exchange_id: EX_RETRY,
      reply_id: second.reply_id,
      parent_reply_id: null,
      status: "pending",
      answer: "",
    });
    expect(events.at(-1)).toMatchObject({
      type: "reply",
      exchange_id: EX_RETRY,
      reply_id: second.reply_id,
      status: "completed",
      answer: "Complete answer.",
    });

    const retryCompleted = await retryReply(second.reply_id);
    expect(retryCompleted.response.status).toBe(400);
    expect(JSON.parse(retryCompleted.text)).toMatchObject({
      detail: "Only failed replies can be retried",
    });
  });

  it("retries a failed answer BTW with its saved branch context", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        { kind: "parts", parts: [tokenPart("Parent answer."), finishPart("stop")] },
        { kind: "parts", parts: [tokenPart("Partial BTW.")], errorAfterParts: new Error("provider failure") },
        { kind: "parts", parts: [tokenPart("Complete BTW."), finishPart("stop")] },
      ],
    });
    await startHarness({ language });
    const parent = await api(repliesPath, {
      exchange_id: EX_BRANCH_PARENT,
      question: "Parent question",
      session: { kind: "new", idempotency_key: "retry-btw-session" },
    });
    expect(parent.response.status).toBe(202);
    const parentIds = JSON.parse(parent.text) as { reply_id: string; session_id: string };
    await tailReply(parentIds.reply_id);
    const branch = await api(repliesPath, {
      exchange_id: EX_BRANCH_BTW_1,
      question: "Why this answer?",
      mode: "btw",
      session: {
        kind: "new",
        conversation_kind: "btw",
        idempotency_key: "retry-answer-btw",
        origin: {
          kind: "answer",
          session_id: parentIds.session_id,
          anchor: "answer",
          paragraph: "Parent answer.",
          paragraph_index: 0,
          exchange_id: EX_BRANCH_PARENT,
        },
      },
    });
    expect(branch.response.status).toBe(202);
    const branchIds = JSON.parse(branch.text) as { reply_id: string; session_id: string };
    const failed = await tailReply(branchIds.reply_id);
    expect(replySnapshots(failed.text).at(-1)).toMatchObject({ status: "failed" });
    const retried = await retryReply(branchIds.reply_id);
    expect(retried.response.status).toBe(202);
    const retryIds = JSON.parse(retried.text) as { reply_id: string; session_id: string };
    expect(retryIds.session_id).toBe(branchIds.session_id);
    const completed = await tailReply(retryIds.reply_id);
    expect(replySnapshots(completed.text).at(-1)).toMatchObject({
      kind: "exchange",
      status: "completed",
      answer: "Complete BTW.",
    });
    expect(language.streamCalls[2]?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)).toEqual([
        "Parent question",
        'Passage:\n> Parent answer.\n\nHighlighted: "answer"\n\nWhy this answer?',
      ]);
    const events = await readSessionEvents(branchIds.session_id);
    expect(events.at(-1)).toMatchObject({
      reply_id: retryIds.reply_id,
      parent_reply_id: null,
      exchange_id: EX_BRANCH_BTW_1,
    });
    expect(events[0]).toMatchObject({
      context: { session_id: parentIds.session_id, reply_id: parentIds.reply_id },
      origin: { kind: "answer", exchange_id: EX_BRANCH_PARENT, anchor: "answer" },
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
    const replyId = uuid("00000000-0000-4000-8000-000000020901");
    const exchangeId = uuid(crypto.randomUUID());

    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        const sessions = yield* SessionsService;
        const sessionId = yield* sessions.createSession(id.alice, id.vault, {
          idempotencyKey: "recovered-reply",
          pending: { replyId, exchangeId, question: "resume after restart" },
        });
        yield* db.query((d) => d
          .insert(replies)
          .values({
            id: replyId,
            vaultId: id.vault,
            userId: id.alice,
            sessionId,
            kind: "exchange",
            status: "running",
            answer: "partial",
            sources: [],
            request: {
              reply_id: replyId,
              question: "resume after restart",
              mode: "query",
              exchange_id: exchangeId,
              session: { kind: "existing", id: sessionId },
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
          reply: yield* db.query((d) => d.select().from(replies).where(eq(replies.id, uuid(replyId))))
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
    const checkpoint = JSON.parse(
      await readFile(
        join(currentState().storageRoot, "vaults", id.vault, "operations", "replies", `${replyId}.json`),
        "utf8",
      ),
    ) as { readonly query: { readonly turnStart: number } };
    expect(checkpoint.query.turnStart).toBe(1);
    expect(promptContentHash(recorded.prompts[0]!.content)).toBe(recorded.prompts[0]!.hash);
    expect(costs.lookups).toEqual([]);
  });

  it("replays the previous turn's tool results verbatim and stubs older ones", async () => {
    const stubToolResult =
      "(tool result omitted from context; call the tool again if you need it)";
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [
            toolCallPart(0, "tc-alpha", "read_document", { path: "wiki/alpha.md" }),
            finishPart("tool_calls", "verbatim-round-1"),
          ],
        },
        {
          kind: "parts",
          parts: [tokenPart("First answer."), finishPart("stop", "verbatim-gen-1")],
        },
        {
          kind: "parts",
          parts: [
            toolCallPart(0, "tc-source", "read_document", { path: "raw/texts/source.md" }),
            finishPart("tool_calls", "verbatim-round-2"),
          ],
        },
        {
          kind: "parts",
          parts: [tokenPart("Second answer."), finishPart("stop", "verbatim-gen-2")],
        },
        { kind: "parts", parts: [tokenPart("Third."), finishPart("stop", "verbatim-gen-3")] },
      ],
    });
    await startHarness({ language });

    const submit = async (
      exchangeId: string,
      question: string,
      sessionId: string | null,
    ) => {
      const created = await api(repliesPath, {
        exchange_id: exchangeId,
        question,
        mode: "query",
        session: sessionId === null
          ? { kind: "new", idempotency_key: "verbatim-session-key" }
          : { kind: "existing", id: sessionId },
      });
      expect(created.response.status).toBe(202);
      const ids = JSON.parse(created.text) as { reply_id: string; session_id: string };
      const tail = await tailReply(ids.reply_id);
      expect(replySnapshots(tail.text).at(-1)).toMatchObject({ status: "completed" });
      return ids;
    };

    const firstIds = await submit(EX_VERBATIM_1, "First question", null);
    await submit(EX_VERBATIM_2, "Second question", firstIds.session_id);
    await submit(EX_VERBATIM_3, "Third question", firstIds.session_id);

    expect(language.streamCalls).toHaveLength(5);
    const firstTurnToolContent = language.streamCalls[1]!.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "tc-alpha",
    )?.content;
    const secondTurnToolContent = language.streamCalls[3]!.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "tc-source",
    )?.content;
    expect(firstTurnToolContent).toBeTypeOf("string");
    expect(secondTurnToolContent).toBeTypeOf("string");

    const third = language.streamCalls[4]!.messages;
    expect(third).toHaveLength(11);
    expect(third[0]).toMatchObject({ role: "system" });
    expect(third[1]).toEqual({
      role: "user",
      content: "First question",
      tool_calls: undefined,
    });
    expect(third[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "tc-alpha",
          type: "function",
          function: {
            name: "read_document",
            arguments: JSON.stringify({ path: "wiki/alpha.md" }),
          },
        },
      ],
    });
    expect(third[3]).toEqual({
      role: "tool",
      tool_call_id: "tc-alpha",
      content: stubToolResult,
    });
    expect(third[3].content).not.toBe(firstTurnToolContent);
    expect(third[4]).toEqual({
      role: "assistant",
      content: "First answer.",
      tool_calls: undefined,
    });
    expect(third[5]).toEqual({
      role: "user",
      content: "Second question",
      tool_calls: undefined,
    });
    expect(third[6]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "tc-source",
          type: "function",
          function: {
            name: "read_document",
            arguments: JSON.stringify({ path: "raw/texts/source.md" }),
          },
        },
      ],
    });
    expect(third[7]).toEqual({
      role: "tool",
      tool_call_id: "tc-source",
      content: secondTurnToolContent,
    });
    expect(third[8]).toEqual({
      role: "assistant",
      content: "Second answer.",
      tool_calls: undefined,
    });
    expect(third[9]).toEqual({
      role: "user",
      content: "Third question",
      tool_calls: undefined,
    });
    expect(third[10]).toEqual({ role: "assistant", content: "Third." });
  });

  it("keeps a BTW's inherited context fixed and promotes the same conversation", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [tokenPart("Parent answer."), finishPart("stop", "branch-parent")],
        },
        {
          kind: "parts",
          parts: [tokenPart("First BTW answer."), finishPart("stop", "branch-btw-1")],
        },
        {
          kind: "parts",
          parts: [tokenPart("Main answer."), finishPart("stop", "branch-main")],
        },
        {
          kind: "parts",
          parts: [tokenPart("Second BTW answer."), finishPart("stop", "branch-btw-2")],
        },
        { kind: "parts", parts: [tokenPart("Promoted answer."), finishPart("stop")] },
      ],
    });
    await startHarness({ language });

    const root = await api(repliesPath, {
      exchange_id: EX_BRANCH_PARENT,
      question: "Parent question",
      mode: "query",
      session: { kind: "new", idempotency_key: "branch-session-key" },
    });
    expect(root.response.status).toBe(202);
    const rootIds = JSON.parse(root.text) as { reply_id: string; session_id: string };
    const rootTail = await tailReply(rootIds.reply_id);
    expect(replySnapshots(rootTail.text).at(-1)).toMatchObject({ status: "completed" });

    let btwSessionId: string | null = null;
    const sendBtw = async (exchangeId: string, question: string) => {
      const created = await api(repliesPath, {
        exchange_id: exchangeId,
        question,
        mode: "btw",
        session: btwSessionId === null ? {
          kind: "new",
          conversation_kind: "btw",
          idempotency_key: "branch-btw-key",
          origin: {
            kind: "answer",
            session_id: rootIds.session_id,
            anchor: "answer",
            paragraph_index: 0,
            paragraph: "Parent answer.",
            exchange_id: EX_BRANCH_PARENT,
          },
        } : { kind: "existing", id: btwSessionId },
      });
      expect(created.response.status).toBe(202);
      const ids = JSON.parse(created.text) as { reply_id: string; session_id: string };
      btwSessionId = ids.session_id;
      const tail = await tailReply(ids.reply_id);
      expect(replySnapshots(tail.text).at(-1)).toMatchObject({ status: "completed" });
      return ids.reply_id;
    };
    const firstBtwReplyId = await sendBtw(EX_BRANCH_BTW_1, "First BTW");

    const follow = await api(repliesPath, {
      exchange_id: EX_BRANCH_FOLLOW_UP,
      question: "Main follow-up",
      mode: "query",
      session: { kind: "existing", id: rootIds.session_id },
    });
    expect(follow.response.status).toBe(202);
    const followIds = JSON.parse(follow.text) as { reply_id: string };
    const followTail = await tailReply(followIds.reply_id);
    expect(replySnapshots(followTail.text).at(-1)).toMatchObject({ status: "completed" });
    const secondBtwReplyId = await sendBtw(EX_BRANCH_BTW_2, "Second BTW");

    expect(language.streamCalls).toHaveLength(4);
    const btwContext = [
      { role: "user", content: "Parent question", tool_calls: undefined },
      { role: "assistant", content: "Parent answer.", tool_calls: undefined },
      {
        role: "user",
        content: 'Passage:\n> Parent answer.\n\nHighlighted: "answer"\n\nFirst BTW',
        tool_calls: undefined,
      },
    ];
    const firstBtw = language.streamCalls[1]!.messages;
    expect(firstBtw).toHaveLength(5);
    expect(firstBtw[0]).toMatchObject({ role: "system" });
    expect(String(firstBtw[0].content)).toContain("This is a BTW");
    expect(firstBtw.slice(1, 4)).toEqual(btwContext);
    expect(firstBtw[4]).toEqual({ role: "assistant", content: "First BTW answer." });

    const secondBtw = language.streamCalls[3]!.messages;
    expect(secondBtw).toHaveLength(7);
    expect(secondBtw.slice(1, 4)).toEqual(btwContext);
    expect(secondBtw[4]).toEqual({
      role: "assistant",
      content: "First BTW answer.",
      tool_calls: undefined,
    });
    expect(secondBtw[5]).toEqual({
      role: "user",
      content: "Second BTW",
      tool_calls: undefined,
    });
    expect(secondBtw[6]).toEqual({ role: "assistant", content: "Second BTW answer." });

    const main = language.streamCalls[2]!.messages;
    expect(main.filter((message) => message.role === "user").map((message) => message.content)).toEqual(
      ["Parent question", "Main follow-up"],
    );
    expect(JSON.stringify(main)).not.toContain("Passage");
    expect(JSON.stringify(main)).not.toContain("Highlighted");
    expect(JSON.stringify(main)).not.toContain("Second BTW");

    const sessionResponse = await getWithToken(
      `/vaults/${id.vault}/sessions/${rootIds.session_id}`,
    );
    expect(sessionResponse.status).toBe(200);
    const sessionBody = (await sessionResponse.json()) as {
      events: readonly Record<string, unknown>[];
      threads: readonly OriginSessionDetail[];
    };
    const exchangeEvents = sessionBody.events.filter((event) => event.type === "exchange");
    expect(exchangeEvents).toHaveLength(2);
    expect(exchangeEvents.map((event) => event.query)).toEqual(["Parent question", "Main follow-up"]);
    expect(sessionBody.threads).toHaveLength(1);
    expect(sessionBody.threads[0]?.session).toMatchObject({
      id: btwSessionId,
      kind: "btw",
      origin: { kind: "answer", exchange_id: EX_BRANCH_PARENT, anchor: "answer", paragraph_index: 0, paragraph: "Parent answer." },
    });
    expect(sessionBody.threads[0]?.events.filter((event) => event.type === "exchange")).toEqual([
        expect.objectContaining({
          exId: EX_BRANCH_BTW_1,
          query: "First BTW",
          answer: "First BTW answer.",
        }),
        expect.objectContaining({
          exId: EX_BRANCH_BTW_2,
          reply_id: secondBtwReplyId,
          query: "Second BTW",
          answer: "Second BTW answer.",
        }),
      ]);
    expect(firstBtwReplyId).not.toBe(secondBtwReplyId);

    const markdown = await readFile(
      join(
        currentState().storageRoot,
        "vaults",
        id.vault,
        "sessions",
        `${rootIds.session_id}.md`,
      ),
      "utf8",
    );
    expect(markdown).not.toContain("First BTW");
    const before = await readSessionEvents(btwSessionId!);
    const nested = await api(repliesPath, {
      exchange_id: crypto.randomUUID(),
      question: "Nested question",
      session: {
        kind: "new", conversation_kind: "btw", idempotency_key: "nested-btw",
        origin: { kind: "answer", session_id: btwSessionId, exchange_id: EX_BRANCH_BTW_1, anchor: "answer", paragraph: "First BTW answer.", paragraph_index: 0 },
      },
    });
    expect(nested.response.status).toBe(400);
    expect(language.streamCalls).toHaveLength(4);
    const hidden = await getWithToken(`/vaults/${id.vault}/sessions`);
    expect(JSON.stringify(await hidden.json())).not.toContain(btwSessionId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const promoted = await api(`/vaults/${id.vault}/sessions/${btwSessionId}/continue`, {});
      expect(promoted.response.ok).toBe(true);
    }
    expect(await readSessionEvents(btwSessionId!)).toEqual(before);
    const visible = await getWithToken(`/vaults/${id.vault}/sessions`);
    expect(JSON.stringify(await visible.json())).toContain(btwSessionId);
    const continuation = await api(repliesPath, {
      exchange_id: crypto.randomUUID(), question: "Continue the thought",
      session: { kind: "existing", id: btwSessionId },
    });
    expect(continuation.response.status).toBe(202);
    await tailReply((JSON.parse(continuation.text) as { reply_id: string }).reply_id);
    const promotedMessages = language.streamCalls[4]!.messages;
    expect(String(promotedMessages[0]?.content)).not.toContain("This is a BTW");
    expect(promotedMessages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "Parent question", 'Passage:\n> Parent answer.\n\nHighlighted: "answer"\n\nFirst BTW', "Second BTW", "Continue the thought",
    ]);
  });

  it("inherits the origin read from the root turn", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [tokenPart("Root doc answer."), finishPart("stop", "origin-root")],
        },
        {
          kind: "parts",
          parts: [tokenPart("Doc answer."), finishPart("stop", "origin-doc")],
        },
        {
          kind: "parts",
          parts: [tokenPart("Third answer."), finishPart("stop", "origin-third")],
        },
      ],
    });
    await startHarness({ language });
    await writeVaultFile(
      id.vault,
      "raw/texts/source.md",
      "---\ntitle: Raw Source\n---\nRaw source paragraph body with the quoted claim in it.\n",
    );

    const root = await api(repliesPath, {
      exchange_id: EX_ORIGIN_ROOT,
      origin_path: "raw/texts/source.md",
      question: "First doc BTW",
      mode: "btw",
      session: {
        kind: "new",
        idempotency_key: "origin-inherit-session-key",
        origin_scope: "vault",
        origin: {
          kind: "document",
          doc_path: "raw/texts/source.md",
          origin_scope: "vault",
          anchor: "quote",
          paragraph: "Raw quote",
          paragraph_index: 0,
        },
      },
    });
    expect(root.response.status).toBe(202);
    const rootIds = JSON.parse(root.text) as { reply_id: string; session_id: string };
    const rootTail = await tailReply(rootIds.reply_id);
    expect(replySnapshots(rootTail.text).at(-1)).toMatchObject({ status: "completed" });

    const submit = async (exchangeId: string, question: string, originPath?: string) => {
      const created = await api(repliesPath, {
        exchange_id: exchangeId,
        question,
        mode: "btw",
        session: { kind: "existing", id: rootIds.session_id },
        origin_path: originPath,
      });
      expect(created.response.status).toBe(202);
      const ids = JSON.parse(created.text) as { reply_id: string };
      const tail = await tailReply(ids.reply_id);
      expect(replySnapshots(tail.text).at(-1)).toMatchObject({ status: "completed" });
    };
    await submit(EX_ORIGIN_DOC, "Doc follow-up");
    await submit(EX_ORIGIN_THIRD, "Third doc follow-up", "raw/texts/source.md");

    expect(language.streamCalls).toHaveLength(3);
    const rootHits = originReadHits(language.streamCalls[0]!.messages);
    expect(rootHits).toHaveLength(1);
    const rootCall = rootHits[0]?.call;
    expect(rootCall).toMatchObject({
      id: expect.any(String),
      function: {
        name: "read_document",
        arguments: JSON.stringify({ path: "raw/texts/source.md" }),
      },
    });
    const rootId = rootCall?.id;
    const rootTool = language.streamCalls[0]!.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === rootId,
    );
    expect(rootTool?.content).toBeTypeOf("string");
    for (const messages of [language.streamCalls[1]!.messages, language.streamCalls[2]!.messages]) {
      const hits = originReadHits(messages);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.call).toEqual(rootCall);
      const composedIndex = messages.findIndex(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("Passage:"),
      );
      expect(composedIndex).toBeGreaterThan(0);
      expect(hits[0]?.index).toBeLessThan(composedIndex);
    }
    const docFollowUp = language.streamCalls[1]!.messages;
    expect(
      docFollowUp.find((message) => message.role === "tool" && message.tool_call_id === rootId)
        ?.content,
    ).toEqual(rootTool?.content);
    const thirdFollowUp = language.streamCalls[2]!.messages;
    expect(thirdFollowUp).toContainEqual({
      role: "tool",
      tool_call_id: rootId,
      content: "(tool result omitted from context; call the tool again if you need it)",
    });
  });

  it("chains past a failed reply", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        { kind: "parts", parts: [tokenPart("A."), finishPart("stop", "chain-a")] },
        { kind: "throw", error: new Error("provider secret") },
        { kind: "parts", parts: [tokenPart("C."), finishPart("stop", "chain-c")] },
      ],
    });
    await startHarness({ language });

    const root = await api(repliesPath, {
      exchange_id: EX_CHAIN_1,
      question: "First question",
      mode: "query",
      session: { kind: "new", idempotency_key: "chain-session-key" },
    });
    expect(root.response.status).toBe(202);
    const rootIds = JSON.parse(root.text) as { reply_id: string; session_id: string };
    const rootTail = await tailReply(rootIds.reply_id);
    expect(replySnapshots(rootTail.text).at(-1)).toMatchObject({ status: "completed" });

    const failed = await api(repliesPath, {
      exchange_id: EX_CHAIN_2,
      question: "Second question",
      mode: "query",
      session: { kind: "existing", id: rootIds.session_id },
    });
    expect(failed.response.status).toBe(202);
    const failedIds = JSON.parse(failed.text) as { reply_id: string };
    const failedTail = await tailReply(failedIds.reply_id);
    expect(replySnapshots(failedTail.text).at(-1)).toMatchObject({ status: "failed" });

    const third = await api(repliesPath, {
      exchange_id: EX_CHAIN_3,
      question: "Third question",
      mode: "query",
      session: { kind: "existing", id: rootIds.session_id },
    });
    expect(third.response.status).toBe(202);
    const thirdIds = JSON.parse(third.text) as { reply_id: string };
    const thirdTail = await tailReply(thirdIds.reply_id);
    expect(replySnapshots(thirdTail.text).at(-1)).toMatchObject({ status: "completed" });

    const thirdMessages = language.streamCalls[2]!.messages;
    expect(thirdMessages).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "First question", tool_calls: undefined },
      { role: "assistant", content: "A.", tool_calls: undefined },
      { role: "user", content: "Third question", tool_calls: undefined },
      { role: "assistant", content: "C." },
    ]);
    expect(JSON.stringify(thirdMessages)).not.toContain("Second question");

    const sessionResponse = await getWithToken(
      `/vaults/${id.vault}/sessions/${rootIds.session_id}`,
    );
    expect(sessionResponse.status).toBe(200);
    const sessionBody = (await sessionResponse.json()) as {
      events: readonly Record<string, unknown>[];
    };
    const exchangeEvents = sessionBody.events.filter((event) => event.type === "exchange");
    expect(exchangeEvents).toHaveLength(3);
    expect(exchangeEvents.map((event) => event.exId)).toEqual([
      EX_CHAIN_1,
      EX_CHAIN_2,
      EX_CHAIN_3,
    ]);
    expect(exchangeEvents.map((event) => event.answer)).toEqual(["A.", "", "C."]);
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
      content: expect.stringContaining('"sort"'),
    });
    expect(secondRound).toContainEqual({
      role: "tool",
      tool_call_id: "tc-expand",
      content: expect.stringContaining('"start"'),
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
