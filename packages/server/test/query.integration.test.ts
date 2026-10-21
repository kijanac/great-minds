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
  topics,
  users,
  vaultMemberships,
  vaults,
  wikiArticles,
} from "@great-minds/database";
import {
  CreateReplyRequest,
  CreateReplyResponse,
  SessionResponse,
  SessionId,
  ShareCreateResult,
  Uuid,
} from "@great-minds/domain";
import { and, eq, sql } from "drizzle-orm";
import { Deferred, Effect, Layer, Option, Redacted, Result, Schema, Stream } from "effect";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";

import { makeAppLayer } from "../src/app-layer.ts";
import { ClockService, makeTestClock } from "../src/clock.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { promptContentHash } from "../src/crypto.ts";
import { StructuredLogger, StructuredLoggerLive } from "../src/logging.ts";
import {
  parseOpenRouterStream,
  type LlmAssistantToolCall,
  type LlmMessage,
  type ModelStreamPart,
} from "../src/llm.ts";
import { ParallelSearchService } from "../src/parallel.ts";
import { makeTestMailer } from "../src/mailer.ts";
import { RepliesService, ReplyWorkflow } from "../src/replies.ts";
import { startServer } from "../src/server.ts";
import { SessionsService } from "../src/sessions.ts";
import { ReplyAdmission } from "../src/conversation-history/admission.ts";
import { ReplySettlement } from "../src/conversation-history/settlement.ts";
import { completion } from "./fixtures/conversation-history.ts";
import { parseHistory } from "../src/conversation-history/history.ts";
import type { HistoryStoreShape } from "../src/conversation-history/store.ts";
import { storageBackendError } from "../src/storage/object-store.ts";
import {
  replyHistoryTestDatabaseUrl,
  runHistoryDatabase,
} from "./fixtures/reply-history-database.ts";
import { seedLegacySources } from "./fixtures/source-documents.ts";
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

const EX_ACCEPTED_ONCE = "00000000-0000-4000-8000-000000000302";
const EX_ANCHORED = "00000000-0000-4000-8000-000000000303";
const EX_FAILED = "00000000-0000-4000-8000-00000000030a";
const EX_RETRY = "00000000-0000-4000-8000-00000000030b";
const EX_BRANCH_PARENT = "00000000-0000-4000-8000-00000000030f";
const EX_BRANCH_BTW_1 = "00000000-0000-4000-8000-000000000310";
const EX_BRANCH_BTW_2 = "00000000-0000-4000-8000-000000000311";

type TestServices =
  | AppConfig
  | Database
  | ClockService
  | RepliesService
  | ReplyAdmission
  | ReplySettlement
  | SessionsService
  | StructuredLogger
  | TokenService
  | WorkflowEngine.WorkflowEngine;

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
  readonly historyStore?: (histories: HistoryStoreShape) => HistoryStoreShape;
  readonly logger?: Layer.Layer<StructuredLogger>;
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

const databaseUrl = () => replyHistoryTestDatabaseUrl;

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
  publicWebUrl: new URL("http://localhost:5173"),
  typstBinary: "typst",
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
      yield* db
        .query((d) => d.insert(users).values({ id: userId, email, createdAt: initialTime }))
        .pipe(Effect.orDie);
    }),
  );

const startHarness = async (options: HarnessOptions) => {
  await runHistoryDatabase(Effect.void);
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
  const decorateHistory = options.historyStore;
  const appLayer = makeAppLayer({
    config: configLayer,
    clock: clock.layer,
    mailer: makeTestMailer().layer,
    logger: options.logger ?? StructuredLoggerLive,
    languageModel: options.language.layer,
    embeddings: embeddings.layer,
    costLookup: costs.layer,
    parallelSearch:
      options.parallel?.layer ?? options.parallelLayer ?? makeDisabledParallelSearch(),
    ...(decorateHistory === undefined ? {} : { decorateHistory }),
  });
  const started = await startServer({ layer: appLayer, host: "127.0.0.1", port: 0 });
  state = { started, storageRoot, token: "" };
  await resetDatabase();
  await seedFixtures(false);
  state = { started, storageRoot, token: await issueToken(id.alice) };
  return { started, storageRoot, token: state.token, costs, embeddings };
};

const startLiveHarness = async () => {
  await runHistoryDatabase(Effect.void);
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
        .query((d) =>
          d
            .insert(users)
            .values({ id: id.alice, email: "alice-query@example.com", createdAt: initialTime }),
        )
        .pipe(Effect.orDie);
      yield* db
        .query((d) =>
          d.insert(vaults).values({
            id: id.vault,
            name: "Query Vault",
            ownerId: id.alice,
            createdAt: initialTime,
          }),
        )
        .pipe(Effect.orDie);
      yield* db
        .query((d) =>
          d.insert(vaultMemberships).values({
            id: uuid("00000000-0000-4000-8000-000000020701"),
            vaultId: id.vault,
            userId: id.alice,
            role: "OWNER",
          }),
        )
        .pipe(Effect.orDie);
      yield* db
        .query((d) =>
          d.insert(topics).values([
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
          ]),
        )
        .pipe(Effect.orDie);
      yield* db
        .query((d) =>
          d.insert(wikiArticles).values([
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
          ]),
        )
        .pipe(Effect.orDie);
      yield* db
        .query((d) =>
          d.insert(backlinks).values([
            { sourceArticleId: id.articleAlpha, targetArticleId: id.articleBeta },
            { sourceArticleId: id.articleBeta, targetArticleId: id.articleAlpha },
          ]),
        )
        .pipe(Effect.orDie);
      yield* db
        .transaction((tx) =>
          seedLegacySources(tx, {
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
          }),
        )
        .pipe(Effect.orDie);
      yield* db
        .query((d) =>
          d.insert(searchIndex).values([
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
          ]),
        )
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
    path.endsWith("/replies") && typeof body === "object" && body !== null && !Array.isArray(body)
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
  readonly status: "admitting" | "running" | "settling" | "completed" | "failed" | "stopped";
  readonly answer: string;
  readonly sources: readonly Record<string, unknown>[];
  readonly error: string | null;
  readonly version: number;
};

const replySnapshots = (text: string): ReplySnapshot[] =>
  text.split("\n\n").flatMap((block) => {
    const lines = block.split("\n");
    const event =
      lines
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trimStart() ?? "message";
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return event === "message" && data.length > 0 ? [JSON.parse(data) as ReplySnapshot] : [];
  });

const runReply = async (body: Record<string, unknown>) => {
  const created = await api(repliesPath, {
    exchange_id: crypto.randomUUID(),
    session: { kind: "new", idempotency_key: crypto.randomUUID() },
    ...body,
  });
  if (created.response.status !== 202) {
    return { ...created, accepted: undefined, snapshots: [] as ReplySnapshot[] };
  }
  const accepted = Schema.decodeUnknownSync(CreateReplyResponse)(JSON.parse(created.text));
  const streamed = await tailReply(accepted.reply_id);
  return { ...streamed, accepted, snapshots: replySnapshots(streamed.text) };
};

const finishReply = async (
  body: Record<string, unknown>,
  status: ReplySnapshot["status"] = "completed",
) => {
  const result = await runReply(body);
  expect(result.snapshots.at(-1)).toMatchObject({ status });
  assert(result.accepted);
  return result.accepted;
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
  const parsed = parseHistory(SessionId.make(sessionId), new TextEncoder().encode(content));
  if (Result.isFailure(parsed)) throw parsed.failure;
  return parsed.success.records;
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
    const sessionId = await runDb(
      Effect.gen(function* () {
        const admission = yield* ReplyAdmission;
        const response = yield* admission.accept(
          id.alice,
          id.vault,
          Schema.decodeUnknownSync(CreateReplyRequest)({
            reply_id: replyId,
            exchange_id: exchangeId,
            question: "Stop before work starts",
            session: { kind: "new", idempotency_key: crypto.randomUUID() },
          }),
        );
        return response.session_id;
      }),
    );
    expect((await api(`${repliesPath}/${replyId}/stop`, {})).response.status).toBe(204);
    await runDb(
      Effect.gen(function* () {
        const service = yield* RepliesService;
        expect(yield* service.prepareStep(replyId)).toMatchObject({ outcome: "stopped" });
        yield* service.finalizeStep(replyId, "stopped", null);
      }),
    );
    expect(replySnapshots((await tailReply(replyId)).text).at(-1)).toMatchObject({
      status: "stopped",
      answer: "",
      error: null,
    });
    expect((await readSessionEvents(sessionId)).at(-1)).toMatchObject({
      outcome: { status: "stopped" },
      context_messages: [{ role: "user", content: "Stop before work starts" }],
    });
    expect(language.streamCalls).toHaveLength(0);
  });

  it.each(["Partial answer.", ""])(
    "stops a pending model response with %j, saves it, and follows up in the same conversation",
    async (answer) => {
      let close!: (result: IteratorResult<ModelStreamPart>) => void;
      const closed = new Promise<IteratorResult<ModelStreamPart>>((resolve) => {
        close = resolve;
      });
      let sent = false;
      const language = makeScriptedLanguageModel({
        streams: [
          {
            kind: "stream",
            stream: {
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
            },
          },
          { kind: "parts", parts: [tokenPart("A follow-up answer."), finishPart("stop")] },
        ],
      });
      await startHarness({ language });
      const created = await api(repliesPath, {
        exchange_id: crypto.randomUUID(),
        question: "A question to stop",
        session: { kind: "new", idempotency_key: crypto.randomUUID() },
      });
      const ids = JSON.parse(created.text) as { reply_id: string; session_id: string };
      await vi.waitFor(
        async () => {
          const rows = await runDb(
            Effect.flatMap(Database, (db) =>
              db.query((d) =>
                d
                  .select()
                  .from(replies)
                  .where(eq(replies.id, uuid(ids.reply_id))),
              ),
            ),
          );
          expect(rows[0].answer).toBe(answer);
          expect(language.streamCalls).toHaveLength(1);
        },
        { timeout: 10_000 },
      );
      const stopped = await api(`${repliesPath}/${ids.reply_id}/stop`, {});
      expect(stopped.response.status).toBe(204);
      const tail = await tailReply(ids.reply_id);
      expect(replySnapshots(tail.text).at(-1)).toMatchObject({
        status: "stopped",
        answer,
        error: null,
      });
      expect(await closed).toEqual({ done: true, value: undefined });
      expect((await api(`${repliesPath}/${ids.reply_id}/stop`, {})).response.status).toBe(204);
      const nodes = (await readSessionEvents(ids.session_id)).filter(
        (event) => event.type === "settlement",
      );
      expect(nodes).toHaveLength(1);
      expect(nodes.at(-1)).toMatchObject({ outcome: { status: "stopped" }, answer });
      const reloaded = await getWithToken(`/vaults/${id.vault}/sessions/${ids.session_id}`);
      expect(await reloaded.json()).toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({ type: "exchange", answer, status: "stopped" }),
        ]),
      });
      const followUp = await runReply({
        question: "Continue from there",
        session: { kind: "existing", id: ids.session_id },
      });
      expect(followUp.snapshots.at(-1)?.status).toBe("completed");
      expect(language.streamCalls).toHaveLength(2);
      expect(language.streamCalls[1].messages).toEqual(
        expect.arrayContaining([
          { role: "user", content: "A question to stop" },
          ...(answer ? [{ role: "assistant", content: answer }] : []),
          { role: "user", content: "Continue from there" },
        ]),
      );
      expect(
        (await readSessionEvents(ids.session_id))
          .filter((event) => event.type === "attempt")
          .at(-1),
      ).toMatchObject({ parent_reply_id: ids.reply_id });
    },
  );

  it.each(["search", "extraction"])(
    "stops active web %s and preserves a valid transcript for the next model call",
    async (stage) => {
      let toolStarted = false;
      let toolStopped = false;
      const pending = Effect.sync(() => {
        toolStarted = true;
      }).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            toolStopped = true;
          }),
        ),
      );
      const language = makeScriptedLanguageModel({
        streams: [
          {
            kind: "parts",
            parts: [
              tokenPart("Looking for sources."),
              toolCallPart(0, "read-first", "read_document", { path: "wiki/alpha.md" }),
              toolCallPart(1, "search-pending", "web_search", { query: "capital" }),
              finishPart("tool_calls"),
            ],
          },
          { kind: "parts", parts: [tokenPart("Continuing after the stop."), finishPart("stop")] },
        ],
        completions: [pending],
      });
      await startHarness({
        language,
        parallelLayer: Layer.succeed(ParallelSearchService, {
          hasApiKey: true,
          search: () =>
            stage === "search"
              ? pending
              : Effect.succeed([
                  {
                    title: "External result",
                    url: "https://example.test/result",
                    excerpts: ["A fact about capital."],
                  },
                ]),
        }),
      });
      await writeVaultFile(id.vault, "config.yaml", "name: Query Vault\nweb_search: true\n");
      const created = await api(repliesPath, {
        exchange_id: crypto.randomUUID(),
        question: "Research capital",
        session: { kind: "new", idempotency_key: crypto.randomUUID() },
      });
      const ids = JSON.parse(created.text) as { reply_id: string; session_id: string };
      await vi.waitFor(() => expect(toolStarted).toBe(true), { timeout: 10_000 });
      expect((await api(`${repliesPath}/${ids.reply_id}/stop`, {})).response.status).toBe(204);
      expect(replySnapshots((await tailReply(ids.reply_id)).text).at(-1)).toMatchObject({
        status: "stopped",
      });
      expect(toolStopped).toBe(true);
      expect(language.completeCalls).toHaveLength(stage === "extraction" ? 1 : 0);
      const node = (await readSessionEvents(ids.session_id))
        .filter((event) => event.type === "settlement")
        .at(-1)!;
      expect(node.sources).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ pending: true })]),
      );
      expect(node.context_messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            tool_call_id: "read-first",
            content: expect.stringContaining("Alpha article body"),
          }),
          {
            role: "tool",
            tool_call_id: "search-pending",
            content: "Tool call cancelled because the user stopped the response.",
          },
        ]),
      );
      const followUp = await runReply({
        question: "Use what you have",
        session: { kind: "existing", id: ids.session_id },
      });
      expect(followUp.snapshots.at(-1)?.status).toBe("completed");
      expect(language.streamCalls).toHaveLength(2);
      expect(language.streamCalls[1].messages).toEqual(
        expect.arrayContaining([...node.context_messages!]),
      );
    },
  );

  it("fences the real progress flush and Stop request after a result is frozen", async () => {
    let markWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      markWaiting = resolve;
    });
    let close!: (result: IteratorResult<ModelStreamPart>) => void;
    const closed = new Promise<IteratorResult<ModelStreamPart>>((resolve) => {
      close = resolve;
    });
    const publishing = await Effect.runPromise(Deferred.make<void>());
    const publish = await Effect.runPromise(Deferred.make<void>());
    let sent = false;
    let interrupted = false;
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "stream",
          stream: {
            [Symbol.asyncIterator]: () => ({
              next: () => {
                if (!sent) {
                  sent = true;
                  return Promise.resolve({
                    done: false as const,
                    value: tokenPart("In-flight partial"),
                  });
                }
                markWaiting();
                return closed;
              },
              return: () => {
                interrupted = true;
                close({ done: true, value: undefined });
                return closed;
              },
            }),
          },
        },
      ],
    });
    await startHarness({
      language,
      historyStore: (store) => ({
        ...store,
        commit: (address, writes, receipt) =>
          Effect.gen(function* () {
            if (writes.some((write) => write.type === "settlement")) {
              yield* Deferred.succeed(publishing, undefined);
              yield* Deferred.await(publish);
            }
            return yield* store.commit(address, writes, receipt);
          }),
      }),
    });
    try {
      const replyId = Uuid.make(crypto.randomUUID());
      const created = await api(repliesPath, {
        reply_id: replyId,
        exchange_id: crypto.randomUUID(),
        question: "Freeze an active response",
        session: { kind: "new", idempotency_key: crypto.randomUUID() },
      });
      expect(created.response.status).toBe(202);
      await waiting;
      const frozen = await runDb(
        Effect.gen(function* () {
          const db = yield* Database;
          const settlement = yield* ReplySettlement;
          yield* settlement.begin(replyId, { ...completion(), answer: "Frozen answer" });
          return (yield* db.query((d) =>
            d.select().from(replies).where(eq(replies.id, replyId)),
          ))[0];
        }),
      );
      expect(frozen.status).toBe("settling");
      expect((await api(`${repliesPath}/${replyId}/stop`, {})).response.status).toBe(204);
      await Effect.runPromise(Deferred.await(publishing));
      expect(interrupted).toBe(true);
      const current = await runDb(
        Effect.gen(function* () {
          const db = yield* Database;
          return (yield* db.query((d) =>
            d.select().from(replies).where(eq(replies.id, replyId)),
          ))[0];
        }),
      );
      expect(current).toEqual(frozen);
      await Effect.runPromise(Deferred.succeed(publish, undefined));
      expect(replySnapshots((await tailReply(replyId)).text).at(-1)).toMatchObject({
        status: "completed",
        answer: "Frozen answer",
      });
    } finally {
      close({ done: true, value: undefined });
      await Effect.runPromise(Deferred.succeed(publish, undefined));
    }
  });

  it("keeps completed replies unchanged and restricts stopping to the reply owner", async () => {
    const language = makeScriptedLanguageModel({
      streams: [{ kind: "parts", parts: [tokenPart("Finished."), finishPart("stop")] }],
    });
    await startHarness({ language });
    const result = await runReply({ question: "A short question" });
    const replyId = result.snapshots.at(-1)!.reply_id;
    expect((await api(`${repliesPath}/${replyId}/stop`, {})).response.status).toBe(204);
    expect(replySnapshots((await tailReply(replyId)).text).at(-1)).toMatchObject({
      status: "completed",
      answer: "Finished.",
    });
    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        const service = yield* RepliesService;
        yield* db.query((d) =>
          d
            .update(replies)
            .set({ status: "running", stopRequested: true })
            .where(eq(replies.id, uuid(replyId))),
        );
        yield* service.finalizeStep(uuid(replyId), "stopped", null);
      }),
    );
    expect(replySnapshots((await tailReply(replyId)).text).at(-1)).toMatchObject({
      status: "completed",
      answer: "Finished.",
    });
    expect((await api(`${repliesPath}/${crypto.randomUUID()}/stop`, {})).response.status).toBe(404);
    await insertUser(id.bob, "stop-bob@example.com");
    await runDb(
      Effect.flatMap(Database, (db) =>
        db.query((d) =>
          d.insert(vaultMemberships).values({
            id: uuid(crypto.randomUUID()),
            vaultId: id.vault,
            userId: id.bob,
            role: "VIEWER",
          }),
        ),
      ),
    );
    const bobToken = await issueToken(id.bob);
    const forbidden = await apiWithToken(`${repliesPath}/${replyId}/stop`, {}, bobToken);
    expect(forbidden.response.status).toBe(404);
    const privateStream = await fetch(
      `${currentState().started.url}/v1${repliesPath}/${replyId}/stream`,
      {
        headers: { authorization: `Bearer ${bobToken}` },
      },
    );
    expect(privateStream.status).toBe(404);
    expect(await privateStream.text()).not.toContain("Finished.");
    expect(language.streamCalls).toHaveLength(1);
  });

  it("stops an authorized private stream before sending progress after membership is revoked", async () => {
    const language = makeScriptedLanguageModel({ streams: [] });
    await startHarness({ language });
    const events = await runDb(
      Effect.gen(function* () {
        const admission = yield* ReplyAdmission;
        const service = yield* RepliesService;
        const db = yield* Database;
        const accepted = yield* admission.accept(
          id.alice,
          id.vault,
          Schema.decodeUnknownSync(CreateReplyRequest)({
            reply_id: crypto.randomUUID(),
            exchange_id: crypto.randomUUID(),
            question: "Private progress",
            session: { kind: "new", idempotency_key: "revoke-private-stream" },
          }),
        );
        yield* db.query((d) =>
          d
            .update(replies)
            .set({ answer: "Progress must stay private" })
            .where(eq(replies.id, accepted.reply_id)),
        );
        const stream = yield* service.stream(id.alice, id.vault, accepted.reply_id);
        return yield* Stream.runCollect(
          stream.pipe(
            Stream.tap((event) =>
              event.event === "connected"
                ? db.query((d) =>
                    d
                      .delete(vaultMemberships)
                      .where(
                        and(
                          eq(vaultMemberships.userId, id.alice),
                          eq(vaultMemberships.vaultId, id.vault),
                        ),
                      ),
                  )
                : Effect.void,
            ),
          ),
        );
      }),
    );
    expect(events.map((event) => event.event)).toEqual(["connected"]);
    expect(JSON.stringify(events)).not.toContain("Progress must stay private");
    expect(language.streamCalls).toHaveLength(0);
  });

  it("prepares an accepted BTW after continuation without changing its frozen mode", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        { kind: "parts", parts: [tokenPart("Brief answer."), finishPart("stop")] },
        { kind: "parts", parts: [tokenPart("Further answer."), finishPart("stop")] },
      ],
    });
    await startHarness({ language });
    const input = Schema.decodeUnknownSync(CreateReplyRequest)({
      reply_id: crypto.randomUUID(),
      exchange_id: crypto.randomUUID(),
      question: "Why this passage?",
      session: {
        kind: "new",
        conversation_kind: "btw",
        idempotency_key: "continue-before-prepare",
        origin: {
          kind: "document",
          doc_path: "wiki/alpha.md",
          origin_scope: "vault",
          anchor: "Alpha",
          paragraph: "Alpha article body.",
          paragraph_index: 0,
        },
      },
    });
    const accepted = await runDb(
      Effect.flatMap(ReplyAdmission, (service) => service.accept(id.alice, id.vault, input)),
    );
    expect(language.streamCalls).toHaveLength(0);
    expect(
      (await api(`/vaults/${id.vault}/sessions/${accepted.session_id}/continue`, {})).response
        .status,
    ).toBe(200);
    expect((await api(repliesPath, input)).response.status).toBe(202);
    expect(replySnapshots((await tailReply(accepted.reply_id)).text).at(-1)?.status).toBe(
      "completed",
    );
    expect(String(language.streamCalls[0].messages[0].content)).toContain("This is a BTW");
    const next = await runReply({
      question: "Take this further",
      session: { kind: "existing", id: accepted.session_id },
    });
    expect(next.snapshots.at(-1)?.status).toBe("completed");
    expect(String(language.streamCalls[1].messages[0].content)).not.toContain("This is a BTW");
    const records = await readSessionEvents(accepted.session_id);
    expect(
      records
        .filter((record) => record.type === "settlement")
        .map((record) => record.generation?.mode),
    ).toEqual(["btw", "query"]);
    expect(language.streamCalls).toHaveLength(2);
  });

  it("redispatches a marked operation when its workflow is absent without generating twice", async () => {
    const language = makeScriptedLanguageModel({
      streams: [{ kind: "parts", parts: [tokenPart("Reconciled once."), finishPart("stop")] }],
    });
    await startHarness({ language });
    const input = Schema.decodeUnknownSync(CreateReplyRequest)({
      reply_id: crypto.randomUUID(),
      exchange_id: crypto.randomUUID(),
      question: "Recover missing dispatch",
      session: { kind: "new", idempotency_key: "missing-dispatch" },
    });
    const accepted = await runDb(
      Effect.gen(function* () {
        const admission = yield* ReplyAdmission;
        const db = yield* Database;
        const result = yield* admission.accept(id.alice, id.vault, input);
        yield* db.query((d) =>
          d
            .update(replies)
            .set({ dispatchedAt: initialTime, dispatchedTaskId: result.reply_id })
            .where(eq(replies.id, result.reply_id)),
        );
        const service = yield* RepliesService;
        yield* Effect.all([service.reconcileOnce(), service.reconcileOnce()], { concurrency: 2 });
        return result;
      }),
    );
    expect(replySnapshots((await tailReply(accepted.reply_id)).text).at(-1)).toMatchObject({
      status: "completed",
      answer: "Reconciled once.",
    });
    expect(language.streamCalls).toHaveLength(1);
  });

  it("revisits older obligations even while newer conversations are admitted", async () => {
    let blocked = false;
    const observed: SessionId[] = [];
    const language = makeScriptedLanguageModel({ streams: [] });
    await startHarness({
      language,
      historyStore: (histories) => ({
        ...histories,
        read: (address, receipt) => {
          if (!blocked) return histories.read(address, receipt);
          observed.push(address.session_id);
          return Effect.fail(
            storageBackendError("read", address.session_id, new Error("Injected outage")),
          );
        },
      }),
    });
    const accept = (suffix: string) =>
      runDb(
        Effect.flatMap(ReplyAdmission, (service) =>
          service.accept(
            id.alice,
            id.vault,
            Schema.decodeUnknownSync(CreateReplyRequest)({
              reply_id: `00000000-0000-4000-8000-00000000900${suffix}`,
              exchange_id: crypto.randomUUID(),
              question: "Still owed",
              session: { kind: "new", idempotency_key: `fair-scan-${suffix}` },
            }),
          ),
        ),
      );
    const first = await accept("1");
    const second = await accept("2");
    blocked = true;
    await runDb(Effect.flatMap(RepliesService, (service) => service.reconcileOnce()));
    blocked = false;
    await accept("3");
    blocked = true;
    await runDb(Effect.flatMap(RepliesService, (service) => service.reconcileOnce()));
    await runDb(Effect.flatMap(RepliesService, (service) => service.reconcileOnce()));
    expect(observed).toEqual([first.session_id, second.session_id, first.session_id]);
    expect(language.streamCalls).toHaveLength(0);
  });

  it("settles failed preparation after history recovery without silently generating a response", async () => {
    let unavailable = false;
    const log = vi.fn<StructuredLogger["Service"]["warn"]>(() => Effect.void);
    const privateDiagnostic = "PRIVATE_DIAGNOSTIC_SENTINEL";
    const language = makeScriptedLanguageModel({
      streams: [
        { kind: "parts", parts: [tokenPart("Recovered after storage."), finishPart("stop")] },
      ],
    });
    await startHarness({
      language,
      logger: Layer.succeed(StructuredLogger, { info: log, warn: log, error: log }),
      historyStore: (histories) => ({
        ...histories,
        read: (address, receipt) =>
          unavailable
            ? Effect.fail(
                storageBackendError("read", address.session_id, new Error(privateDiagnostic)),
              )
            : histories.read(address, receipt),
      }),
    });
    const input = Schema.decodeUnknownSync(CreateReplyRequest)({
      reply_id: crypto.randomUUID(),
      exchange_id: crypto.randomUUID(),
      question: "Wait for history",
      session: { kind: "new", idempotency_key: "suspended-preparation" },
    });
    const accepted = await runDb(
      Effect.flatMap(ReplyAdmission, (service) => service.accept(id.alice, id.vault, input)),
    );
    unavailable = true;
    expect((await api(repliesPath, input)).response.status).toBe(202);
    await vi.waitFor(
      async () => {
        const state = await runDb(
          Effect.gen(function* () {
            return yield* ReplyWorkflow.poll(
              yield* ReplyWorkflow.executionId({ replyId: accepted.reply_id }),
            );
          }),
        );
        expect(Option.isSome(state) ? state.value._tag : null).toBe("Complete");
      },
      { timeout: 10_000 },
    );
    expect(language.streamCalls).toHaveLength(0);
    expect(log.mock.calls).toContainEqual([
      "reply_generation_step_failed",
      { reply_id: accepted.reply_id, generation_cursor: 0, error_tag: "StorageBackendError" },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateDiagnostic);
    unavailable = false;
    await runDb(Effect.flatMap(RepliesService, (service) => service.reconcileOnce()));
    expect(replySnapshots((await tailReply(accepted.reply_id)).text).at(-1)).toMatchObject({
      status: "failed",
      answer: "",
    });
    expect(language.streamCalls).toHaveLength(0);
    const retried = await retryReply(accepted.reply_id);
    expect(retried.response.status).toBe(202);
    const retryId = Schema.decodeUnknownSync(Uuid)(JSON.parse(retried.text).reply_id);
    expect(replySnapshots((await tailReply(retryId)).text).at(-1)).toMatchObject({
      status: "completed",
      answer: "Recovered after storage.",
    });
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
      { exchange_id: "../../wiki/index", session: { kind: "existing", id: "schema-only" } },
      {
        session: {
          kind: "new",
          idempotency_key: "bad-exchange",
          conversation_kind: "btw",
          origin: {
            kind: "answer",
            session_id: "schema-only",
            exchange_id: "../../wiki/index",
            anchor: "passage",
            paragraph: "passage",
            paragraph_index: 0,
          },
        },
      },
      {
        session: {
          kind: "new",
          idempotency_key: "incomplete-anchor",
          conversation_kind: "btw",
          origin: { kind: "answer", anchor: "incomplete anchor" },
        },
      },
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

    const identifiers = Schema.decodeUnknownSync(CreateReplyResponse)(JSON.parse(first.text));
    expect((await readSessionEvents(identifiers.session_id))[1]).toMatchObject({
      type: "attempt",
      reply_id: replyId,
      exchange_id: EX_ACCEPTED_ONCE,
    });
    const tail = await tailReply(identifiers.reply_id);
    expect(replySnapshots(tail.text).at(-1)).toMatchObject({
      status: "completed",
      answer: "Accepted once.",
    });
    expect(language.streamCalls).toHaveLength(1);

    const events = (await readSessionEvents(identifiers.session_id)).filter(
      (event) => event.type !== "conversation",
    );
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.reply_id)).toEqual([replyId, replyId]);
    expect(events.map((event) => event.type)).toEqual(["attempt", "settlement"]);
  });

  it("records the clean question and inherits one anchored document read, stubbing it only when older", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        { kind: "parts", parts: [tokenPart("Root answer."), finishPart("stop")] },
        {
          kind: "parts",
          parts: [
            toolCallPart(0, "tc-latest", "read_document", { path: "wiki/alpha.md" }),
            finishPart("tool_calls"),
          ],
        },
        { kind: "parts", parts: [tokenPart("Second answer."), finishPart("stop")] },
        { kind: "parts", parts: [tokenPart("Third answer."), finishPart("stop")] },
      ],
    });
    await startHarness({ language });
    const source = "---\ntitle: Raw Source\n---\nThe original document body.";
    await writeVaultFile(id.vault, "raw/texts/source.md", source);
    const origin = {
      kind: "document",
      doc_path: "raw/texts/source.md",
      origin_scope: "vault",
      anchor: "the highlighted claim",
      paragraph: "The surrounding passage.",
      paragraph_index: 2,
    };
    const root = await finishReply({
      exchange_id: EX_ANCHORED,
      origin_path: origin.doc_path,
      question: "What does this claim imply?",
      session: { kind: "new", idempotency_key: "anchored", origin },
    });
    const composed =
      'Passage:\n> The surrounding passage.\n\nHighlighted: "the highlighted claim"\n\nWhat does this claim imply?';
    const events = await readSessionEvents(root.session_id);
    expect(events[0]).toMatchObject({ type: "conversation", origin });
    expect(events[1]).toMatchObject({ type: "attempt", question: "What does this claim imply?" });
    const recorded = events.find((event) => event.type === "settlement");
    expect(recorded?.context_messages?.filter((message) => message.role === "user")).toEqual([
      { role: "user", content: composed },
    ]);
    await finishReply({
      question: "What follows?",
      session: { kind: "existing", id: root.session_id },
    });
    await finishReply({
      question: "And then?",
      session: { kind: "existing", id: root.session_id },
      origin_path: origin.doc_path,
    });
    const rootMessages = language.streamCalls[0]!.messages;
    const [read] = originReadHits(rootMessages);
    expect(originReadHits(rootMessages)).toHaveLength(1);
    expect(read.call.function).toEqual({
      name: "read_document",
      arguments: JSON.stringify({ path: origin.doc_path }),
    });
    const toolContent = rootMessages.find(
      (message) => message.role === "tool" && message.tool_call_id === read.call.id,
    )?.content;
    expect(String(toolContent)).toContain(source);
    for (const call of language.streamCalls.slice(1)) {
      const hits = originReadHits(call.messages).filter(
        (hit) => hit.call.function.arguments === read.call.function.arguments,
      );
      expect(hits).toHaveLength(1);
      expect(hits[0].call).toEqual(read.call);
      expect(hits[0].index).toBeLessThan(
        call.messages.findIndex(
          (message) => message.role === "user" && message.content === composed,
        ),
      );
    }
    expect(
      language.streamCalls[1]!.messages.filter((message) => message.role === "user").map(
        (message) => message.content,
      ),
    ).toEqual([composed, "What follows?"]);
    expect(
      language.streamCalls[1]!.messages.find(
        (message) => message.role === "tool" && message.tool_call_id === read.call.id,
      )?.content,
    ).toBe(toolContent);
    const third = language.streamCalls[3]!.messages;
    expect(language.streamCalls).toHaveLength(4);
    expect(third).toContainEqual({
      role: "tool",
      tool_call_id: read.call.id,
      content: "(tool result omitted from context; call the tool again if you need it)",
    });
    const latest = language.streamCalls[2]!.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "tc-latest",
    );
    expect(latest?.content).toContain("Alpha article body with capital.");
    expect(third).toContainEqual(latest);
    expect(originReadHits(third).find((hit) => hit.call.id === "tc-latest")?.call.function).toEqual(
      {
        name: "read_document",
        arguments: JSON.stringify({ path: "wiki/alpha.md" }),
      },
    );
    expect(
      third.filter((message) => message.role === "user").map((message) => message.content),
    ).toEqual([composed, "What follows?", "And then?"]);
    expect(
      third
        .filter((message) => message.role === "assistant" && !message.tool_calls)
        .map((message) => message.content),
    ).toEqual(["Root answer.", "Second answer.", "Third answer."]);
  });

  it("keeps an unfinished provider stream private without fallback and allows explicit retry", async () => {
    const partial = "Private partial must not be shared.";
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "stream",
          stream: parseOpenRouterStream(
            new Response(
              `data: ${JSON.stringify({
                choices: [{ delta: { content: partial }, finish_reason: null }],
              })}\n\n`,
            ),
          ),
        },
        { kind: "parts", parts: [tokenPart("Explicit retry."), finishPart("stop")] },
      ],
    });
    await startHarness({ language });

    const created = await api(repliesPath, {
      exchange_id: EX_FAILED,
      question: "Fail this answer",
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
    expect(events.filter((event) => event.type === "attempt")).toEqual([
      expect.objectContaining({ exchange_id: EX_FAILED, reply_id: identifiers.reply_id }),
    ]);
    expect(events.filter((event) => event.type === "settlement")).toEqual([
      expect.objectContaining({
        reply_id: identifiers.reply_id,
        outcome: {
          status: "failed",
          code: "generation_failed",
          message: "Something went wrong while answering. Try again in a minute.",
        },
        answer: partial,
      }),
    ]);
    const privateRead = await getWithToken(
      `/vaults/${id.vault}/sessions/${identifiers.session_id}`,
    );
    const privateBody = await privateRead.text();
    expect(privateBody).toContain(partial);
    expect(privateBody).toContain('"status":"failed"');
    expect(privateBody).not.toContain("context_messages");
    expect(privateBody).not.toContain("system_prompt_hash");
    const promotion = await api(
      `/vaults/${id.vault}/sessions/${identifiers.session_id}/exchanges/${EX_FAILED}/promote`,
      {},
    );
    expect(promotion.response.status).toBe(400);
    expect(JSON.parse(promotion.text)).toMatchObject({
      detail: "Only completed or stopped answers can be promoted",
    });
    const shareResponse = await api("/shares", {
      subject_kind: "session",
      subject_id: identifiers.session_id,
    });
    expect(shareResponse.response.status).toBe(201);
    const shared = Schema.decodeUnknownSync(ShareCreateResult)(JSON.parse(shareResponse.text));
    const publicRead = await fetch(
      `${currentState().started.url}/v1/public/shares/${shared.share.token}`,
    );
    expect(publicRead.status).toBe(200);
    const publicBody = await publicRead.text();
    expect(publicBody).not.toContain(partial);
    expect(publicBody).not.toContain("context_messages");
    expect(publicBody).not.toContain("system_prompt_hash");
    expect(language.streamCalls.map((call) => call.model)).toEqual(["primary/test-model"]);
    const retried = await retryReply(identifiers.reply_id);
    expect(retried.response.status).toBe(202);
    const retriedTail = await tailReply(JSON.parse(retried.text).reply_id);
    expect(replySnapshots(retriedTail.text).at(-1)).toMatchObject({
      status: "completed",
      answer: "Explicit retry.",
    });
    expect(language.streamCalls.map((call) => call.model)).toEqual([
      "primary/test-model",
      "primary/test-model",
    ]);
  });

  it("retries the original document question without later context, using the current future mode", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [tokenPart("Incomplete answer.")],
          errorAfterParts: new Error("provider secret"),
        },
        { kind: "parts", parts: [tokenPart("A later answer."), finishPart("stop")] },
        { kind: "parts", parts: [tokenPart("Complete answer."), finishPart("stop")] },
      ],
    });
    await startHarness({ language });
    const first = await finishReply(
      {
        exchange_id: EX_RETRY,
        question: "Try this answer",
        session: {
          kind: "new",
          idempotency_key: "retry-session",
          conversation_kind: "btw",
          origin: {
            kind: "document",
            doc_path: "raw/texts/source.md",
            origin_scope: "vault",
            anchor: "The highlighted claim.",
            paragraph: "The surrounding passage.",
            paragraph_index: 3,
          },
        },
      },
      "failed",
    );
    await finishReply({
      question: "A later question",
      session: { kind: "existing", id: first.session_id },
    });
    expect(
      (await api(`/vaults/${id.vault}/sessions/${first.session_id}/continue`, {})).response.status,
    ).toBe(200);
    const retryId = crypto.randomUUID();
    const retried = await retryReply(first.reply_id, retryId);
    const replay = await retryReply(first.reply_id, retryId);
    expect(retried.response.status).toBe(202);
    expect(replay.response.status).toBe(202);
    expect(JSON.parse(replay.text)).toEqual(JSON.parse(retried.text));
    expect(Schema.decodeUnknownSync(CreateReplyResponse)(JSON.parse(retried.text))).toEqual({
      reply_id: retryId,
      session_id: first.session_id,
    });
    expect(replySnapshots((await tailReply(retryId)).text).at(-1)).toMatchObject({
      status: "completed",
      answer: "Complete answer.",
      error: null,
    });
    const messages = language.streamCalls[2]!.messages;
    expect(
      messages.filter((message) => message.role === "user").map((message) => message.content),
    ).toEqual([
      'Passage:\n> The surrounding passage.\n\nHighlighted: "The highlighted claim."\n\nTry this answer',
    ]);
    expect(String(messages[0].content)).not.toContain("This is a BTW");
    expect(language.streamCalls).toHaveLength(3);
    expect((await readSessionEvents(first.session_id)).at(-2)).toMatchObject({
      type: "attempt",
      reply_id: retryId,
      exchange_id: EX_RETRY,
      parent_reply_id: null,
      previous_attempt_id: first.reply_id,
    });
    expect((await retryReply(retryId)).response.status).toBe(400);
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
          prompts: yield* db
            .query((d) => d.select().from(prompts).where(eq(prompts.hash, systemPromptHash)))
            .pipe(Effect.orDie),
          reply: yield* db
            .query((d) =>
              d
                .select()
                .from(replies)
                .where(eq(replies.id, uuid(replyId))),
            )
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
      dispatchedTaskId: replyId,
      dispatchedAt: expect.any(Date),
      generationCursor: 10,
      activeGenerationStep: null,
      activeGenerationKind: null,
      activeGenerationKey: null,
    });
    const checkpoint = JSON.parse(
      await readFile(
        join(
          currentState().storageRoot,
          "vaults",
          id.vault,
          "operations",
          "replies",
          `${replyId}.json`,
        ),
        "utf8",
      ),
    ) as { readonly query: { readonly turnStart: number } };
    expect(checkpoint.query.turnStart).toBe(1);
    expect(promptContentHash(recorded.prompts[0]!.content)).toBe(recorded.prompts[0]!.hash);
    expect(costs.lookups).toEqual([]);
  });

  it("keeps branch context fixed, projects its saved notes, and changes only future mode on Continue", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        { kind: "parts", parts: [tokenPart("Parent answer."), finishPart("stop")] },
        { kind: "parts", parts: [tokenPart("Before answer."), finishPart("stop")] },
        {
          kind: "parts",
          parts: [tokenPart("Partial BTW.")],
          errorAfterParts: new Error("provider failure"),
        },
        ...["First BTW answer.", "Main answer.", "Second BTW answer.", "Continued answer."].map(
          (answer) => ({ kind: "parts" as const, parts: [tokenPart(answer), finishPart("stop")] }),
        ),
      ],
    });
    await startHarness({ language });
    const root = await finishReply({ exchange_id: EX_BRANCH_PARENT, question: "Parent question" });
    await finishReply({
      question: "Before note",
      session: { kind: "existing", id: root.session_id },
    });
    const failed = await finishReply(
      {
        exchange_id: EX_BRANCH_BTW_1,
        question: "First BTW",
        session: {
          kind: "new",
          conversation_kind: "btw",
          idempotency_key: "branch",
          origin: {
            kind: "answer",
            session_id: root.session_id,
            exchange_id: EX_BRANCH_PARENT,
            anchor: "answer",
            paragraph: "Parent answer.",
            paragraph_index: 0,
          },
        },
      },
      "failed",
    );
    const retried = await retryReply(failed.reply_id);
    expect(retried.response.status).toBe(202);
    const child = Schema.decodeUnknownSync(CreateReplyResponse)(JSON.parse(retried.text));
    expect(child.session_id).toBe(failed.session_id);
    expect(replySnapshots((await tailReply(child.reply_id)).text).at(-1)).toMatchObject({
      status: "completed",
      answer: "First BTW answer.",
    });
    expect((await readSessionEvents(child.session_id)).at(-2)).toMatchObject({
      previous_attempt_id: failed.reply_id,
      parent_reply_id: null,
      exchange_id: EX_BRANCH_BTW_1,
    });
    await finishReply({
      question: "Main follow-up",
      session: { kind: "existing", id: root.session_id },
    });
    const second = await finishReply({
      exchange_id: EX_BRANCH_BTW_2,
      question: "Second BTW",
      session: { kind: "existing", id: child.session_id },
    });
    expect(child.reply_id).not.toBe(second.reply_id);
    expect(child.session_id).not.toBe(root.session_id);
    const dialogue = (messages: readonly LlmMessage[]) =>
      messages.filter((m) => m.role !== "system").map((m) => [m.role, m.content]);
    const branch = [
      ["user", "Parent question"],
      ["assistant", "Parent answer."],
      ["user", "Before note"],
      ["assistant", "Before answer."],
      ["user", 'Passage:\n> Parent answer.\n\nHighlighted: "answer"\n\nFirst BTW'],
      ["assistant", "First BTW answer."],
    ];
    expect(String(language.streamCalls[3]!.messages[0].content)).toContain("This is a BTW");
    expect(dialogue(language.streamCalls[3]!.messages)).toEqual(branch);
    expect(dialogue(language.streamCalls[5]!.messages)).toEqual([
      ...branch,
      ["user", "Second BTW"],
      ["assistant", "Second BTW answer."],
    ]);
    expect(dialogue(language.streamCalls[4]!.messages)).toEqual([
      ["user", "Parent question"],
      ["assistant", "Parent answer."],
      ["user", "Before note"],
      ["assistant", "Before answer."],
      ["user", "Main follow-up"],
      ["assistant", "Main answer."],
    ]);
    const path = `/vaults/${id.vault}/sessions/${root.session_id}`;
    const saved = Schema.decodeUnknownSync(SessionResponse)(
      await (await getWithToken(path)).json(),
    );
    expect(
      saved.events.filter((event) => event.type === "exchange").map((event) => event.answer),
    ).toEqual(["Parent answer.", "Before answer.", "Main answer."]);
    expect(saved.threads).toHaveLength(1);
    const note = saved.threads[0];
    expect(note.session).toMatchObject({
      id: child.session_id,
      origin: { exchange_id: EX_BRANCH_PARENT },
    });
    assert(note.availability === "available");
    expect(note.events.filter((event) => event.type === "exchange")).toMatchObject([
      { exId: EX_BRANCH_BTW_1, reply_id: child.reply_id, answer: "First BTW answer." },
      { exId: EX_BRANCH_BTW_2, reply_id: second.reply_id, answer: "Second BTW answer." },
    ]);
    const markdown = await (await getWithToken(`${path}/markdown`)).text();
    for (const text of [
      "# Parent question",
      "## Main follow-up",
      "## Attached notes",
      "First BTW answer.",
      "Second BTW answer.",
    ])
      expect(markdown).toContain(text);
    const before = await readSessionEvents(child.session_id);
    expect(
      (await api(`/vaults/${id.vault}/sessions/${child.session_id}/continue`, {})).response.status,
    ).toBe(200);
    expect(await readSessionEvents(child.session_id)).toEqual(before);
    await finishReply({
      question: "Continue the thought",
      session: { kind: "existing", id: child.session_id },
    });
    expect(language.streamCalls).toHaveLength(7);
    expect(String(language.streamCalls[6]!.messages[0].content)).not.toContain("This is a BTW");
    expect(dialogue(language.streamCalls[6]!.messages)).toEqual([
      ...branch,
      ["user", "Second BTW"],
      ["assistant", "Second BTW answer."],
      ["user", "Continue the thought"],
      ["assistant", "Continued answer."],
    ]);
  });

  it("chains past a failed reply without losing it from private history", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        { kind: "parts", parts: [tokenPart("A."), finishPart("stop")] },
        { kind: "throw", error: new Error("provider secret") },
        { kind: "parts", parts: [tokenPart("C."), finishPart("stop")] },
      ],
    });
    await startHarness({ language });
    const root = await finishReply({ question: "First question" });
    const session = { kind: "existing", id: root.session_id };
    await finishReply({ question: "Second question", session }, "failed");
    await finishReply({ question: "Third question", session });
    expect(
      language.streamCalls[2]!.messages.filter((message) => message.role !== "system").map(
        (message) => [message.role, message.content],
      ),
    ).toEqual([
      ["user", "First question"],
      ["assistant", "A."],
      ["user", "Third question"],
      ["assistant", "C."],
    ]);
    const saved = Schema.decodeUnknownSync(SessionResponse)(
      await (await getWithToken(`/vaults/${id.vault}/sessions/${root.session_id}`)).json(),
    );
    expect(
      saved.events
        .filter((event) => event.type === "exchange")
        .map((event) => [event.query, event.answer, event.status]),
    ).toEqual([
      ["First question", "A.", "completed"],
      ["Second question", "", "failed"],
      ["Third question", "C.", "completed"],
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
        yield* db
          .query((d) =>
            d.insert(searchIndex).values([
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
            ]),
          )
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

  it("removes missing sources without losing or duplicating the remaining citations", async () => {
    const language = makeScriptedLanguageModel({
      streams: [
        {
          kind: "parts",
          parts: [
            tokenPart("Looking up sources."),
            toolCallPart(0, "missing", "read_document", { path: "wiki/missing.md" }),
            toolCallPart(1, "read", "read_document", { path: "wiki/alpha.md" }),
            toolCallPart(2, "read-again", "read_document", { path: "wiki/alpha.md" }),
            toolCallPart(3, "links", "linked_articles", { path: "wiki/alpha.md" }),
            toolCallPart(4, "links-again", "linked_articles", { path: "wiki/alpha.md" }),
            toolCallPart(5, "raw", "read_document", { path: "raw/texts/source.md" }),
            toolCallPart(6, "expand", "expand_context", {
              path: "raw/texts/source.md",
              start: 0,
              end: 1,
            }),
            finishPart("tool_calls"),
          ],
        },
        { kind: "parts", parts: [tokenPart("Resolved."), finishPart("stop")] },
      ],
    });
    await startHarness({ language });
    const { snapshots } = await runReply({ question: "Read and expand these sources" });
    const terminal = snapshots.at(-1);
    expect(terminal).toMatchObject({
      status: "completed",
      answer: "Resolved.",
      sources: [
        { type: "links", label: "wiki/alpha.md" },
        { type: "article", label: "wiki/alpha.md", full: true },
        { type: "raw", label: "raw/texts/source.md", full: true, ranges: [{ start: 0, end: 1 }] },
      ],
    });
    expect(terminal?.sources).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ pending: true })]),
    );
    expect(language.streamCalls).toHaveLength(2);
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
