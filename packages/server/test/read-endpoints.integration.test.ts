import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  apiKeys,
  authCodes,
  backlinks,
  Database,
  pipelineRuns,
  searchIndex,
  sessions,
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeAppLayer } from "../src/app-layer.ts";
import { ClockService, makeTestClock } from "../src/clock.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { sha256Hex } from "../src/crypto.ts";
import { StructuredLogger, StructuredLoggerLive } from "../src/logging.ts";
import { makeTestMailer } from "../src/mailer.ts";
import { startServer } from "../src/server.ts";
import { TokenService } from "../src/tokens.ts";

const initialTime = new Date("2026-07-09T12:00:00.000Z");

const id = {
  alice: "00000000-0000-4000-8000-000000000001",
  bob: "00000000-0000-4000-8000-000000000002",
  mallory: "00000000-0000-4000-8000-000000000003",
  vaultAlpha: "00000000-0000-4000-8000-000000000101",
  vaultBeta: "00000000-0000-4000-8000-000000000102",
  unknownVault: "00000000-0000-4000-8000-000000000199",
  runAlpha: "00000000-0000-4000-8000-000000000201",
  topicAlpha: "00000000-0000-4000-8000-000000000301",
  topicBeta: "00000000-0000-4000-8000-000000000302",
  topicGamma: "00000000-0000-4000-8000-000000000303",
  topicIndex: "00000000-0000-4000-8000-000000000304",
  topicArchived: "00000000-0000-4000-8000-000000000305",
  topicOtherVault: "00000000-0000-4000-8000-000000000306",
  articleAlpha: "00000000-0000-4000-8000-000000000401",
  articleBeta: "00000000-0000-4000-8000-000000000402",
  articleGamma: "00000000-0000-4000-8000-000000000403",
  articleIndex: "00000000-0000-4000-8000-000000000404",
  articleArchived: "00000000-0000-4000-8000-000000000405",
  articleOtherVault: "00000000-0000-4000-8000-000000000406",
  sourceBook: "00000000-0000-4000-8000-000000000501",
  sourceArticle: "00000000-0000-4000-8000-000000000502",
  sourceSpeech: "00000000-0000-4000-8000-000000000503",
  sourceOtherVault: "00000000-0000-4000-8000-000000000504",
  sourceEncoded: "00000000-0000-4000-8000-000000000505",
  apiKeyAlice: "00000000-0000-4000-8000-000000000601",
  sessionAliceOlder: "s-1",
  sessionAliceMain: "s-2",
  sessionBob: "s-bob",
  sessionNoMarkdown: "s-no-md",
  sessionMalformed: "s-malformed",
} as const;

const aliceApiKey = "gm_alice_read_key";

type TestServices = AppConfig | Database | ClockService | StructuredLogger | TokenService;

type TestState = {
  readonly started: Awaited<ReturnType<typeof startServer>>;
  readonly clock: ReturnType<typeof makeTestClock>;
  readonly storageRoot: string;
};

type Fixture = {
  readonly aliceToken: string;
  readonly bobToken: string;
  readonly malloryToken: string;
  readonly aliceApiKey: string;
};

type ApiResponse = {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
};

type PageBody = {
  readonly items: readonly unknown[];
  readonly pagination: {
    readonly limit: number;
    readonly offset: number;
    readonly total: number;
  };
};

let state: TestState | undefined;
let fixture: Fixture | undefined;

const currentState = () => {
  if (state === undefined) {
    throw new Error("test state is not initialized");
  }
  return state;
};

const currentFixture = () => {
  if (fixture === undefined) {
    throw new Error("fixture is not initialized");
  }
  return fixture;
};

const databaseUrl = () => {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
  return value;
};

const testConfig = (url: string, dataDir: string): AppConfigShape => ({
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
  r2BucketPrefix: "gm-test",
  openRouterApiKey: Option.none(),
  openRouterApiUrl: "https://openrouter.ai/api/v1",
  parallelApiKey: Option.none(),
  parallelSearchUrl: "https://api.parallel.ai/v1beta/search",
  queryModel: "z-ai/glm-5.2",
  queryFallbackModels: ["deepseek/deepseek-v3.2"],
  extractModel: "deepseek/deepseek-v3.2",
  mapModel: "deepseek/deepseek-v3.2",
  reduceModel: "anthropic/claude-sonnet-4.6",
  renderModel: "qwen/qwen3.6-plus",
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
  embeddingModel: "qwen/qwen3-embedding-8b",
  corsOrigins: ["http://localhost:5173"],
  suppressAuth: false,
  allowPrivateUrlFetch: false,
  serverHost: "127.0.0.1",
  serverPort: 0,
});

const buildTestState = async () => {
  const clock = makeTestClock(initialTime);
  const storageRoot = await mkdtemp(join(tmpdir(), "great-minds-read-storage-"));
  const configLayer = Layer.succeed(AppConfig, testConfig(databaseUrl(), storageRoot));
  const appLayer = makeAppLayer({
    config: configLayer,
    clock: clock.layer,
    mailer: makeTestMailer().layer,
    logger: StructuredLoggerLive,
  });
  const started = await startServer({ layer: appLayer, host: "127.0.0.1", port: 0 });
  return { started, clock, storageRoot } satisfies TestState;
};

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

const resetStorage = async () => {
  const root = currentState().storageRoot;
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
};

const writeVaultFile = async (vaultId: string, path: string, content: string) => {
  const fullPath = join(currentState().storageRoot, "vaults", vaultId, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
};

const jsonl = (events: readonly unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n");

const issueToken = (userId: string) =>
  runDb(
    Effect.gen(function* () {
      const tokens = yield* TokenService;
      return yield* tokens.issueAccessToken(userId as Uuid, initialTime);
    }),
  );

const seedFixtures = async (): Promise<Fixture> => {
  await runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d
        .insert(users)
        .values([
          {
            id: id.alice,
            email: "alice@example.com",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
          },
          { id: id.bob, email: "bob@example.com", createdAt: new Date("2026-07-01T00:01:00.000Z") },
          {
            id: id.mallory,
            email: "mallory@example.com",
            createdAt: new Date("2026-07-01T00:02:00.000Z"),
          },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(vaults)
        .values([
          {
            id: id.vaultAlpha,
            name: "Alpha Vault",
            ownerId: id.alice,
            createdAt: new Date("2026-07-02T00:00:00.000Z"),
          },
          {
            id: id.vaultBeta,
            name: "Beta Vault",
            ownerId: id.bob,
            createdAt: new Date("2026-07-03T00:00:00.000Z"),
            r2BucketName: "beta-bucket",
          },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(vaultMemberships)
        .values([
          {
            id: "00000000-0000-4000-8000-000000000701",
            vaultId: id.vaultAlpha,
            userId: id.alice,
            role: "OWNER",
          },
          {
            id: "00000000-0000-4000-8000-000000000702",
            vaultId: id.vaultAlpha,
            userId: id.bob,
            role: "EDITOR",
          },
          {
            id: "00000000-0000-4000-8000-000000000703",
            vaultId: id.vaultBeta,
            userId: id.bob,
            role: "OWNER",
          },
          {
            id: "00000000-0000-4000-8000-000000000704",
            vaultId: id.vaultBeta,
            userId: id.alice,
            role: "VIEWER",
          },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(apiKeys)
        .values({
          id: id.apiKeyAlice,
          userId: id.alice,
          keyHash: sha256Hex(aliceApiKey),
          label: "read automation",
          revoked: false,
          createdAt: new Date("2026-07-04T00:00:00.000Z"),
        }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(pipelineRuns)
        .values({
          id: id.runAlpha,
          vaultId: id.vaultAlpha,
          trigger: "test",
          status: "completed",
          currentPhase: "render",
          phaseStatus: "completed",
          progressSteps: [],
          createdAt: new Date("2026-07-05T00:00:00.000Z"),
          updatedAt: new Date("2026-07-05T01:00:00.000Z"),
        }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(topics)
        .values([
          {
            topicId: id.topicAlpha,
            vaultId: id.vaultAlpha,
            slug: "alpha-practice",
            title: "alpha Practice",
            description: "Alpha",
          },
          {
            topicId: id.topicBeta,
            vaultId: id.vaultAlpha,
            slug: "beta-theory",
            title: "Beta Theory",
            description: "Beta",
          },
          {
            topicId: id.topicGamma,
            vaultId: id.vaultAlpha,
            slug: "gamma-lines",
            title: "gamma Lines",
            description: "Gamma",
          },
          {
            topicId: id.topicIndex,
            vaultId: id.vaultAlpha,
            slug: "_index",
            title: "Index",
            description: "Index",
          },
          {
            topicId: id.topicArchived,
            vaultId: id.vaultAlpha,
            slug: "archived-essay",
            title: "Archived Essay",
            description: "Archived",
            articleStatus: "archived",
            supersededBy: id.topicBeta,
          },
          {
            topicId: id.topicOtherVault,
            vaultId: id.vaultBeta,
            slug: "other-vault",
            title: "Other Vault",
            description: "Other",
          },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(wikiArticles)
        .values([
          {
            id: id.articleAlpha,
            vaultId: id.vaultAlpha,
            topicId: id.topicAlpha,
            filePath: "wiki/alpha-practice.md",
            fileHash: "hash-alpha",
            bodyHash: "body-alpha",
            title: "alpha Practice",
            precis: "Alpha precis",
            updatedAt: new Date("2026-07-09T10:00:00.000Z"),
            renderRunId: id.runAlpha,
            tags: ["practice"],
          },
          {
            id: id.articleBeta,
            vaultId: id.vaultAlpha,
            topicId: id.topicBeta,
            filePath: "wiki/beta-theory.md",
            fileHash: "hash-beta",
            bodyHash: "body-beta",
            title: "Beta Theory",
            precis: "Beta precis",
            updatedAt: new Date("2026-07-09T12:00:00.000Z"),
            tags: ["theory"],
          },
          {
            id: id.articleGamma,
            vaultId: id.vaultAlpha,
            topicId: id.topicGamma,
            filePath: "wiki/gamma-lines.md",
            fileHash: "hash-gamma",
            bodyHash: "body-gamma",
            title: "gamma Lines",
            precis: "Gamma precis",
            updatedAt: new Date("2026-07-08T12:00:00.000Z"),
            renderRunId: id.runAlpha,
            tags: ["lines"],
          },
          {
            id: id.articleIndex,
            vaultId: id.vaultAlpha,
            topicId: id.topicIndex,
            filePath: "wiki/_index.md",
            fileHash: "hash-index",
            bodyHash: "body-index",
            title: "Index",
            precis: "Index precis",
            updatedAt: new Date("2026-07-10T12:00:00.000Z"),
            tags: [],
          },
          {
            id: id.articleArchived,
            vaultId: id.vaultAlpha,
            topicId: id.topicArchived,
            filePath: "archive/archived-essay.md",
            fileHash: "hash-archived",
            bodyHash: "body-archived",
            title: "Archived Essay",
            precis: "Archived precis",
            updatedAt: new Date("2026-07-11T12:00:00.000Z"),
            archived: true,
            tags: ["archive"],
          },
          {
            id: id.articleOtherVault,
            vaultId: id.vaultBeta,
            topicId: id.topicOtherVault,
            filePath: "wiki/other-vault.md",
            fileHash: "hash-other",
            bodyHash: "body-other",
            title: "Other Vault",
            precis: "Other precis",
            updatedAt: new Date("2026-07-09T13:00:00.000Z"),
            tags: [],
          },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(sourceDocuments)
        .values([
          {
            id: id.sourceBook,
            vaultId: id.vaultAlpha,
            filePath: "raw/books/capital.md",
            fileHash: "source-hash-book",
            bodyHash: "source-body-book",
            sourceType: "book",
            title: "Capital Volume",
            author: "Karl Marx",
            publishedDate: "1867",
            url: "https://example.test/capital",
            origin: "Marx Archive",
            genre: "critique",
            precis: "A critique of political economy",
            tags: ["economics"],
            derivedExtras: { tradition: "marxist" },
            updatedAt: new Date("2026-07-09T11:00:00.000Z"),
          },
          {
            id: id.sourceArticle,
            vaultId: id.vaultAlpha,
            filePath: "raw/articles/organization.md",
            fileHash: "source-hash-article",
            bodyHash: "source-body-article",
            sourceType: "article",
            title: "On Organization",
            author: "V. I. Lenin",
            genre: "essay",
            tags: ["party"],
            derivedExtras: {},
            updatedAt: new Date("2026-07-09T09:00:00.000Z"),
          },
          {
            id: id.sourceSpeech,
            vaultId: id.vaultAlpha,
            filePath: "raw/speeches/mass-strike.md",
            fileHash: "source-hash-speech",
            bodyHash: "source-body-speech",
            sourceType: "speech",
            precis: "Mentions Marx only in precis, not searchable fields",
            author: "Rosa Luxemburg",
            tags: [],
            derivedExtras: {},
            updatedAt: new Date("2026-07-09T08:00:00.000Z"),
          },
          {
            id: id.sourceEncoded,
            vaultId: id.vaultAlpha,
            filePath: "raw/books/encoded title.md",
            fileHash: "source-hash-encoded",
            bodyHash: "source-body-encoded",
            sourceType: "book",
            title: "Encoded Title",
            author: "Path Writer",
            tags: [],
            derivedExtras: {},
            updatedAt: new Date("2026-07-09T06:00:00.000Z"),
          },
          {
            id: id.sourceOtherVault,
            vaultId: id.vaultBeta,
            filePath: "raw/books/beta.md",
            fileHash: "source-hash-beta",
            bodyHash: "source-body-beta",
            sourceType: "book",
            title: "Beta Source",
            author: "Other Author",
            tags: [],
            derivedExtras: {},
            updatedAt: new Date("2026-07-09T07:00:00.000Z"),
          },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(backlinks)
        .values([
          {
            sourceArticleId: id.articleAlpha,
            targetArticleId: id.articleBeta,
          },
          {
            sourceArticleId: id.articleGamma,
            targetArticleId: id.articleAlpha,
          },
          {
            sourceArticleId: id.articleAlpha,
            targetArticleId: id.articleArchived,
          },
          {
            sourceArticleId: id.articleArchived,
            targetArticleId: id.articleAlpha,
          },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(searchIndex)
        .values(
          Array.from({ length: 106 }, (_, offset) => {
            const index = offset - 1;
            return {
              vaultId: id.vaultAlpha,
              path: "raw/books/capital.md",
              chunkIndex: index,
              heading: index === -1 ? "Metadata" : index < 2 ? "Opening" : "Later",
              body: index === -1 ? "Synthetic metadata row" : `Capital chunk ${index}`,
              contentHash: `chunk-hash-${index}`,
              tsv: sql`to_tsvector('english', ${index === -1 ? "Synthetic metadata row" : `Capital chunk ${index}`})`,
            };
          }),
        ))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(sessions)
        .values([
          {
            id: id.sessionAliceOlder,
            vaultId: id.vaultAlpha,
            userId: id.alice,
            query: "Earlier organizing question",
            origin: null,
            createdAt: new Date("2026-07-06T08:00:00.000Z"),
            updatedAt: new Date("2026-07-06T08:05:00.000Z"),
          },
          {
            id: id.sessionAliceMain,
            vaultId: id.vaultAlpha,
            userId: id.alice,
            query: "How should study circles use source material?",
            origin: {
              doc_path: "wiki/alpha-practice.md",
              anchor: "alpha-anchor",
              paragraph: "Alpha paragraph",
              paragraph_index: 2,
            },
            createdAt: new Date("2026-07-07T09:00:00.000Z"),
            updatedAt: new Date("2026-07-07T09:45:00.000Z"),
            idempotencyKey: "alice-main-key",
          },
          {
            id: id.sessionBob,
            vaultId: id.vaultAlpha,
            userId: id.bob,
            query: "What should editors review first?",
            origin: { doc_path: "raw/books/capital.md", origin_scope: "vault", anchor: null, paragraph: null, paragraph_index: null },
            createdAt: new Date("2026-07-08T10:00:00.000Z"),
            updatedAt: new Date("2026-07-08T10:15:00.000Z"),
            idempotencyKey: "bob-main-key",
          },
        ]))
        .pipe(Effect.orDie);
    }),
  );

  await writeVaultFile(
    id.vaultAlpha,
    "wiki/alpha-practice.md",
    "---\ntitle: alpha Practice\n---\n# Alpha Practice\n\nAlpha body.",
  );
  await writeVaultFile(
    id.vaultAlpha,
    "wiki/beta-theory.md",
    "---\ntitle: Beta Theory\n---\n# Beta Theory\n\nBeta body.",
  );
  await writeVaultFile(
    id.vaultAlpha,
    "archive/archived-essay.md",
    "---\ntitle: Archived Essay\n---\n# Archived Essay\n\nArchived body.",
  );
  await writeVaultFile(
    id.vaultAlpha,
    "wiki/orphan-on-disk.md",
    "---\ntitle: Orphan\n---\n# Orphan\n\nNo registry row.",
  );
  await writeVaultFile(
    id.vaultAlpha,
    "raw/books/capital.md",
    "---\ntitle: Capital Volume\n---\n# Capital\n\nCapital body.",
  );
  await writeVaultFile(
    id.vaultAlpha,
    "raw/books/encoded title.md",
    "---\ntitle: Encoded Title\n---\nEncoded path body.",
  );
  await writeVaultFile(
    id.vaultAlpha,
    `sessions/${id.sessionAliceOlder}.jsonl`,
    jsonl([
      {
        type: "meta",
        id: id.sessionAliceOlder,
        query: "Earlier organizing question",
        ts: "2026-07-06T08:00:00.000Z",
        user_id: id.alice,
        origin: null,
      },
      {
        type: "exchange",
        exId: "ex-old",
        query: "Earlier organizing question",
        thinking: [],
        answer: "Earlier answer.",
        ts: "2026-07-06T08:05:00.000Z",
      },
    ]),
  );
  await writeVaultFile(
    id.vaultAlpha,
    `sessions/${id.sessionAliceMain}.jsonl`,
    jsonl([
      {
        type: "meta",
        id: id.sessionAliceMain,
        query: "Stale pre-reload question",
        ts: "2026-07-01T08:00:00.000Z",
        user_id: id.alice,
        origin: null,
      },
      {
        type: "exchange",
        exId: "ex-stale",
        query: "Stale pre-reload question",
        thinking: [],
        answer: "This belongs to an older client-reused id.",
        ts: "2026-07-01T08:01:00.000Z",
      },
      {
        type: "meta",
        id: id.sessionAliceMain,
        query: "How should study circles use source material?",
        ts: "2026-07-07T09:00:00.000Z",
        user_id: id.alice,
        origin: {
          doc_path: "wiki/alpha-practice.md",
          anchor: "alpha-anchor",
          paragraph: "Alpha paragraph",
          paragraph_index: 2,
        },
      },
      {
        type: "exchange",
        exId: "ex-1",
        query: "How should study circles use source material?",
        thinking: [
          {
            sources: [
              {
                label: "Alpha Practice",
                type: "article",
                title: null,
                scope: null,
                path: null,
                thinking: "Use the article as a shared reference point.",
                ranges: [{ start: 0, end: 2 }],
                full: false,
              },
              {
                label: "Capital Volume",
                type: "raw",
                title: null,
                scope: null,
                path: null,
                thinking: "Raw source grounds the discussion.",
                ranges: [{ start: 3, end: 4 }],
                full: true,
              },
              {
                label: "Search: pedagogy",
                type: "search",
                title: null,
                scope: null,
                path: null,
                thinking: null,
              },
              {
                label: "Prior query",
                type: "query",
                title: null,
                scope: null,
                path: null,
                thinking: "Compare against previous framing.",
              },
              {
                label: "Linked articles",
                type: "links",
                title: null,
                scope: null,
                path: null,
                thinking: "Trace adjacent topics.",
              },
            ],
          },
        ],
        answer: "Start with a concrete passage, then ask what claim it supports.",
        ts: "2026-07-07T09:10:00.000Z",
      },
      {
        type: "btw",
        exId: "ex-1",
        quote: "concrete passage",
        blockOffset: 0,
        context: "Start with a concrete passage",
        exchanges: [
          {
            query: "Why this passage?",
            thinking: [{ sources: [{ label: "Linked articles", type: "links", title: null, scope: null, path: null, thinking: null }] }],
            answer: "It gives the group something specific to test.",
          },
          {
            query: "How do we avoid over-reading it?",
            thinking: [],
            answer: "Keep claims proportional to the evidence.",
          },
        ],
        ts: "2026-07-07T09:20:00.000Z",
      },
      {
        type: "exchange",
        exId: "ex-2",
        query: "What should the facilitator write down?",
        thinking: [],
        answer: "Record the passage, the claim, and unresolved questions.",
        ts: "2026-07-07T09:45:00.000Z",
      },
    ]),
  );
  await writeVaultFile(
    id.vaultAlpha,
    `sessions/${id.sessionAliceMain}.md`,
    "# Stored Session Markdown\n\nThis came from the sidecar.\n",
  );
  await writeVaultFile(
    id.vaultAlpha,
    `sessions/${id.sessionBob}.jsonl`,
    jsonl([
      {
        type: "meta",
        id: id.sessionBob,
        query: "What should editors review first?",
        ts: "2026-07-08T10:00:00.000Z",
        user_id: id.bob,
        origin: { doc_path: "raw/books/capital.md", origin_scope: "vault", anchor: null, paragraph: null, paragraph_index: null },
      },
      {
        type: "exchange",
        exId: "ex-bob",
        query: "What should editors review first?",
        thinking: [],
        answer: "Start with sources that already have provenance.",
        ts: "2026-07-08T10:15:00.000Z",
      },
    ]),
  );
  await writeVaultFile(
    id.vaultAlpha,
    `sessions/${id.sessionNoMarkdown}.jsonl`,
    jsonl([
      {
        type: "meta",
        id: id.sessionNoMarkdown,
        query: "Missing markdown sidecar",
        ts: "2026-07-09T10:00:00.000Z",
        user_id: id.alice,
        origin: null,
      },
    ]),
  );
  await writeVaultFile(
    id.vaultAlpha,
    `sessions/${id.sessionMalformed}.jsonl`,
    `${jsonl([
      {
        type: "meta",
        id: id.sessionMalformed,
        query: "Malformed event handling",
        ts: "2026-07-09T11:00:00.000Z",
        user_id: id.alice,
        origin: null,
      },
      {
        type: "exchange",
        exId: "ex-good",
        query: "Malformed event handling",
        thinking: [],
        answer: "The first event is valid.",
        ts: "2026-07-09T11:01:00.000Z",
      },
      { type: "unknown", ts: "2026-07-09T11:02:00.000Z" },
      {
        type: "exchange",
        query: "Missing exId should be skipped.",
        thinking: [],
        answer: "This event is invalid.",
        ts: "2026-07-09T11:03:00.000Z",
      },
      {
        type: "exchange",
        exId: "ex-after-invalid",
        query: "Does parsing continue after invalid typed events?",
        thinking: [],
        answer: "Yes, invalid typed events are skipped.",
        ts: "2026-07-09T11:04:00.000Z",
      },
    ])}\n{not valid json}\n${JSON.stringify({
      type: "exchange",
      exId: "ex-after-bad-json",
      query: "This tail is truncated.",
      thinking: [],
      answer: "This must not appear.",
      ts: "2026-07-09T11:05:00.000Z",
    })}\n`,
  );

  return {
    aliceToken: await issueToken(id.alice),
    bobToken: await issueToken(id.bob),
    malloryToken: await issueToken(id.mallory),
    aliceApiKey,
  };
};

const rawApi = async (method: string, path: string, bearer?: string, body?: unknown) => {
  const headers = new Headers();
  if (bearer !== undefined) {
    headers.set("authorization", `Bearer ${bearer}`);
  }
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${currentState().started.url}/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};

const api = async (
  method: string,
  path: string,
  bearer?: string,
  body?: unknown,
): Promise<ApiResponse> => {
  const response = await rawApi(method, path, bearer, body);
  const text = await response.text();
  const parsed = text === "" ? undefined : (JSON.parse(text) as unknown);
  return { status: response.status, body: parsed, text };
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object response");
  }
  return value as Record<string, unknown>;
};

const asPage = (value: unknown): PageBody => {
  const record = asRecord(value);
  const items = record.items;
  const pagination = asRecord(record.pagination);
  if (!Array.isArray(items)) {
    throw new Error("expected page items");
  }
  return {
    items,
    pagination: {
      limit: Number(pagination.limit),
      offset: Number(pagination.offset),
      total: Number(pagination.total),
    },
  };
};

const itemRecords = (page: PageBody) => page.items.map(asRecord);

const asArray = (value: unknown) => {
  if (!Array.isArray(value)) {
    throw new Error("expected array response");
  }
  return value;
};

describe("read-only HTTP integration", () => {
  beforeAll(async () => {
    state = await buildTestState();
  });

  beforeEach(async () => {
    currentState().clock.set(initialTime);
    await resetDatabase();
    await resetStorage();
    fixture = await seedFixtures();
  });

  afterAll(async () => {
    const current = state;
    state = undefined;
    fixture = undefined;
    if (current !== undefined) {
      await current.started.close();
      await rm(current.storageRoot, { recursive: true, force: true });
    }
  });

  it("lists caller vaults with roles, API-key access, and pagination validation", async () => {
    const { aliceToken, aliceApiKey: rawKey } = currentFixture();
    const listed = await api("GET", "/vaults", aliceToken);
    expect(listed.status).toBe(200);
    const page = asPage(listed.body);
    const vaultItems = itemRecords(page);
    expect(page.pagination).toEqual({ limit: 50, offset: 0, total: 2 });
    expect(vaultItems.map((vault) => vault.id)).toEqual([id.vaultBeta, id.vaultAlpha]);
    expect(vaultItems[0]?.r2_bucket_name).toBe("beta-bucket");
    expect(vaultItems[1]?.r2_bucket_name).toBeNull();
    expect(asRecord(listed.body).roles).toEqual({
      [id.vaultAlpha]: "owner",
      [id.vaultBeta]: "viewer",
    });

    const withApiKey = await api("GET", "/vaults?limit=1", rawKey);
    expect(withApiKey.status).toBe(200);
    expect(asPage(withApiKey.body).items).toHaveLength(1);

    const zero = await api("GET", "/vaults?limit=0", aliceToken);
    expect(zero.status).toBe(200);
    expect(asPage(zero.body)).toEqual({
      items: [],
      pagination: { limit: 0, offset: 0, total: 2 },
    });

    const cap = await api("GET", "/vaults?limit=200", aliceToken);
    expect(cap.status).toBe(200);
    expect(asPage(cap.body).pagination.limit).toBe(200);

    const pastEnd = await api("GET", "/vaults?offset=99", aliceToken);
    expect(pastEnd.status).toBe(200);
    expect(asPage(pastEnd.body)).toEqual({
      items: [],
      pagination: { limit: 50, offset: 99, total: 2 },
    });

    const overCap = await api("GET", "/vaults?limit=201", aliceToken);
    expect(overCap.status).toBe(422);
    expect(overCap.body).toEqual({ detail: "Invalid query parameters" });

    const unauthenticated = await api("GET", "/vaults");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toEqual({ detail: "Invalid credentials" });
  });

  it("reads vault detail and collapses non-member and unknown vaults to 403", async () => {
    const { aliceToken, malloryToken } = currentFixture();
    const detail = await api("GET", `/vaults/${id.vaultAlpha}`, aliceToken);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      id: id.vaultAlpha,
      name: "Alpha Vault",
      role: "owner",
      member_count: 2,
      article_count: 5,
    });

    const viewerDetail = await api("GET", `/vaults/${id.vaultBeta}`, aliceToken);
    expect(viewerDetail.status).toBe(200);
    expect(asRecord(viewerDetail.body).role).toBe("viewer");

    const existingNotMine = await api("GET", `/vaults/${id.vaultAlpha}`, malloryToken);
    expect(existingNotMine.status).toBe(403);
    expect(existingNotMine.body).toEqual({ detail: "Not a member of this vault" });

    const unknown = await api("GET", `/vaults/${id.unknownVault}`, malloryToken);
    expect(unknown.status).toBe(403);
    expect(unknown.body).toEqual({ detail: "Not a member of this vault" });

    const unauthenticated = await api("GET", `/vaults/${id.vaultAlpha}`);
    expect(unauthenticated.status).toBe(401);
  });

  it("reads default vault config with member guard", async () => {
    const { bobToken, malloryToken } = currentFixture();
    const config = await api("GET", `/vaults/${id.vaultAlpha}/config`, bobToken);
    expect(config.status).toBe(200);
    expect(config.body).toEqual({
      thematic_hint: "",
      kinds: ["person", "event", "organization", "concept"],
    });

    await writeVaultFile(
      id.vaultAlpha,
      "config.yaml",
      "thematic_hint: Prefer movement-level topics.\nkinds:\n  - movement\n  - debate\nweb_search: false\n",
    );
    const customConfig = await api("GET", `/vaults/${id.vaultAlpha}/config`, bobToken);
    expect(customConfig.status).toBe(200);
    expect(customConfig.body).toEqual({
      thematic_hint: "Prefer movement-level topics.",
      kinds: ["movement", "debate"],
    });

    await writeVaultFile(id.vaultAlpha, "config.yaml", "thematic_hint: ''\nkinds: []\n");
    const emptyConfig = await api("GET", `/vaults/${id.vaultAlpha}/config`, bobToken);
    expect(emptyConfig.status).toBe(200);
    expect(emptyConfig.body).toEqual({
      thematic_hint: "",
      kinds: ["person", "event", "organization", "concept"],
    });

    await writeVaultFile(id.vaultAlpha, "config.yaml", "thematic_hint:\nkinds:\n");
    const nullConfig = await api("GET", `/vaults/${id.vaultAlpha}/config`, bobToken);
    expect(nullConfig.status).toBe(200);
    expect(nullConfig.body).toEqual({
      thematic_hint: "",
      kinds: ["person", "event", "organization", "concept"],
    });

    await writeVaultFile(id.vaultAlpha, "config.yaml", "kinds:\n  - movement\n");
    const partialConfig = await api("GET", `/vaults/${id.vaultAlpha}/config`, bobToken);
    expect(partialConfig.status).toBe(200);
    expect(partialConfig.body).toEqual({
      thematic_hint: "",
      kinds: ["movement"],
    });

    const nonMember = await api("GET", `/vaults/${id.vaultAlpha}/config`, malloryToken);
    expect(nonMember.status).toBe(403);
    expect(nonMember.body).toEqual({
      detail: "Only vault members can perform this action",
    });

    const unauthenticated = await api("GET", `/vaults/${id.vaultAlpha}/config`);
    expect(unauthenticated.status).toBe(401);
  });

  it("lists members only for owners with email sort and pagination validation", async () => {
    const { aliceToken, bobToken } = currentFixture();
    const listed = await api("GET", `/vaults/${id.vaultAlpha}/members`, aliceToken);
    expect(listed.status).toBe(200);
    const page = asPage(listed.body);
    expect(page.pagination).toEqual({ limit: 50, offset: 0, total: 2 });
    expect(itemRecords(page)).toEqual([
      { user_id: id.alice, email: "alice@example.com", role: "owner" },
      { user_id: id.bob, email: "bob@example.com", role: "editor" },
    ]);

    const zero = await api("GET", `/vaults/${id.vaultAlpha}/members?limit=0`, aliceToken);
    expect(zero.status).toBe(200);
    expect(asPage(zero.body).pagination).toEqual({ limit: 0, offset: 0, total: 2 });
    expect(asPage(zero.body).items).toEqual([]);

    const pastEnd = await api("GET", `/vaults/${id.vaultAlpha}/members?offset=9`, aliceToken);
    expect(pastEnd.status).toBe(200);
    expect(asPage(pastEnd.body).items).toEqual([]);

    const cap = await api("GET", `/vaults/${id.vaultAlpha}/members?limit=200`, aliceToken);
    expect(cap.status).toBe(200);
    expect(asPage(cap.body).pagination.limit).toBe(200);

    const overCap = await api("GET", `/vaults/${id.vaultAlpha}/members?limit=201`, aliceToken);
    expect(overCap.status).toBe(422);

    const editorDenied = await api("GET", `/vaults/${id.vaultAlpha}/members`, bobToken);
    expect(editorDenied.status).toBe(403);
    expect(editorDenied.body).toEqual({
      detail: "Only vault owners can perform this action",
    });

    const unauthenticated = await api("GET", `/vaults/${id.vaultAlpha}/members`);
    expect(unauthenticated.status).toBe(401);
  });

  it("lists wiki articles alphabetically, filters archived/index/run rows, and enforces authz", async () => {
    const { aliceToken, malloryToken, aliceApiKey: rawKey } = currentFixture();
    const listed = await api("GET", `/vaults/${id.vaultAlpha}/wiki`, aliceToken);
    expect(listed.status).toBe(200);
    const page = asPage(listed.body);
    const articles = itemRecords(page);
    expect(page.pagination).toEqual({ limit: 50, offset: 0, total: 3 });
    expect(articles.map((article) => article.slug)).toEqual([
      "alpha-practice",
      "beta-theory",
      "gamma-lines",
    ]);
    expect(articles.map((article) => article.file_path)).not.toContain("wiki/_index.md");
    expect(articles.map((article) => article.title)).not.toContain("Archived Essay");

    const byRun = await api("GET", `/vaults/${id.vaultAlpha}/wiki?run=${id.runAlpha}`, aliceToken);
    expect(byRun.status).toBe(200);
    expect(itemRecords(asPage(byRun.body)).map((article) => article.slug)).toEqual([
      "alpha-practice",
      "gamma-lines",
    ]);

    const withApiKey = await api("GET", `/vaults/${id.vaultAlpha}/wiki?limit=1`, rawKey);
    expect(withApiKey.status).toBe(200);
    expect(asPage(withApiKey.body).items).toHaveLength(1);

    const byTitle = await api("GET", `/vaults/${id.vaultAlpha}/wiki?contains=BETA`, aliceToken);
    expect(byTitle.status).toBe(200);
    expect(itemRecords(asPage(byTitle.body)).map((article) => article.slug)).toEqual([
      "beta-theory",
    ]);
    expect(asPage(byTitle.body).pagination.total).toBe(1);

    const byPrecis = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/wiki?contains=gamma%20precis`,
      aliceToken,
    );
    expect(byPrecis.status).toBe(200);
    expect(itemRecords(asPage(byPrecis.body)).map((article) => article.slug)).toEqual([
      "gamma-lines",
    ]);

    const noMatch = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/wiki?contains=nonexistent`,
      aliceToken,
    );
    expect(noMatch.status).toBe(200);
    expect(asPage(noMatch.body).items).toEqual([]);

    const byTag = await api("GET", `/vaults/${id.vaultAlpha}/wiki?tag=practice`, aliceToken);
    expect(byTag.status).toBe(200);
    expect(itemRecords(asPage(byTag.body)).map((article) => article.slug)).toEqual([
      "alpha-practice",
    ]);
    expect(asPage(byTag.body).pagination.total).toBe(1);

    const byTagCase = await api("GET", `/vaults/${id.vaultAlpha}/wiki?tag=THEORY`, aliceToken);
    expect(byTagCase.status).toBe(200);
    expect(itemRecords(asPage(byTagCase.body)).map((article) => article.slug)).toEqual([
      "beta-theory",
    ]);

    const tagComposed = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/wiki?tag=practice&run=${id.runAlpha}`,
      aliceToken,
    );
    expect(tagComposed.status).toBe(200);
    expect(itemRecords(asPage(tagComposed.body)).map((article) => article.slug)).toEqual([
      "alpha-practice",
    ]);

    const tagNoMatch = await api("GET", `/vaults/${id.vaultAlpha}/wiki?tag=absent`, aliceToken);
    expect(tagNoMatch.status).toBe(200);
    expect(asPage(tagNoMatch.body).items).toEqual([]);

    const zero = await api("GET", `/vaults/${id.vaultAlpha}/wiki?limit=0`, aliceToken);
    expect(zero.status).toBe(200);
    expect(asPage(zero.body).pagination).toEqual({ limit: 0, offset: 0, total: 3 });
    expect(asPage(zero.body).items).toEqual([]);

    const cap = await api("GET", `/vaults/${id.vaultAlpha}/wiki?limit=200`, aliceToken);
    expect(cap.status).toBe(200);
    expect(asPage(cap.body).pagination.limit).toBe(200);

    const pastEnd = await api("GET", `/vaults/${id.vaultAlpha}/wiki?offset=99`, aliceToken);
    expect(pastEnd.status).toBe(200);
    expect(asPage(pastEnd.body).items).toEqual([]);

    const overCap = await api("GET", `/vaults/${id.vaultAlpha}/wiki?limit=201`, aliceToken);
    expect(overCap.status).toBe(422);

    const nonMember = await api("GET", `/vaults/${id.vaultAlpha}/wiki`, malloryToken);
    expect(nonMember.status).toBe(403);

    const unauthenticated = await api("GET", `/vaults/${id.vaultAlpha}/wiki`);
    expect(unauthenticated.status).toBe(401);
  });

  it("lists recent wiki articles by updated time with pagination boundaries", async () => {
    const { aliceToken, malloryToken } = currentFixture();
    const recent = await api("GET", `/vaults/${id.vaultAlpha}/wiki/recent`, aliceToken);
    expect(recent.status).toBe(200);
    expect(itemRecords(asPage(recent.body)).map((article) => article.slug)).toEqual([
      "beta-theory",
      "alpha-practice",
      "gamma-lines",
    ]);

    const zero = await api("GET", `/vaults/${id.vaultAlpha}/wiki/recent?limit=0`, aliceToken);
    expect(zero.status).toBe(200);
    expect(asPage(zero.body)).toEqual({
      items: [],
      pagination: { limit: 0, offset: 0, total: 3 },
    });

    const cap = await api("GET", `/vaults/${id.vaultAlpha}/wiki/recent?limit=200`, aliceToken);
    expect(cap.status).toBe(200);
    expect(asPage(cap.body).pagination.limit).toBe(200);

    const pastEnd = await api("GET", `/vaults/${id.vaultAlpha}/wiki/recent?offset=99`, aliceToken);
    expect(pastEnd.status).toBe(200);
    expect(asPage(pastEnd.body)).toEqual({
      items: [],
      pagination: { limit: 50, offset: 99, total: 3 },
    });

    const overCap = await api("GET", `/vaults/${id.vaultAlpha}/wiki/recent?limit=201`, aliceToken);
    expect(overCap.status).toBe(422);

    const nonMember = await api("GET", `/vaults/${id.vaultAlpha}/wiki/recent`, malloryToken);
    expect(nonMember.status).toBe(403);

    const unauthenticated = await api("GET", `/vaults/${id.vaultAlpha}/wiki/recent`);
    expect(unauthenticated.status).toBe(401);
  });

  it("reads document bodies from storage with registry lookup, archived fallback, encoding, and authz", async () => {
    const { aliceToken, malloryToken } = currentFixture();
    const wikiDoc = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/doc/wiki/alpha-practice.md`,
      aliceToken,
    );
    expect(wikiDoc.status).toBe(200);
    expect(wikiDoc.body).toMatchObject({
      body: "# Alpha Practice\n\nAlpha body.",
      archived: false,
      superseded_by: null,
      article: {
        kind: "wiki",
        id: id.articleAlpha,
        file_path: "wiki/alpha-practice.md",
        slug: "alpha-practice",
        tags: ["practice"],
      },
    });

    const encodedSlash = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/doc/wiki%2Falpha-practice.md`,
      aliceToken,
    );
    expect(encodedSlash.status).toBe(200);
    expect(asRecord(asRecord(encodedSlash.body).article).file_path).toBe("wiki/alpha-practice.md");

    const rawDoc = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/doc/raw/books/capital.md`,
      aliceToken,
    );
    expect(rawDoc.status).toBe(200);
    expect(rawDoc.body).toMatchObject({
      body: "# Capital\n\nCapital body.",
      article: {
        kind: "source",
        id: id.sourceBook,
        file_path: "raw/books/capital.md",
        title: "Capital Volume",
        derived_extras: { tradition: "marxist" },
      },
    });

    const encodedSpace = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/doc/raw/books/encoded%20title.md`,
      aliceToken,
    );
    expect(encodedSpace.status).toBe(200);
    expect(encodedSpace.body).toMatchObject({
      body: "Encoded path body.",
      article: {
        kind: "source",
        file_path: "raw/books/encoded title.md",
      },
    });

    const archived = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/doc/wiki/archived-essay.md`,
      aliceToken,
    );
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({
      body: "# Archived Essay\n\nArchived body.",
      archived: true,
      superseded_by: "beta-theory",
      article: {
        kind: "wiki",
        id: id.articleArchived,
        file_path: "archive/archived-essay.md",
        slug: "archive/archived-essay",
      },
    });

    const dbRowWithoutFile = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/doc/raw/articles/organization.md`,
      aliceToken,
    );
    expect(dbRowWithoutFile.status).toBe(404);
    expect(dbRowWithoutFile.body).toEqual({
      detail: "Document not found: raw/articles/organization.md",
    });

    const fileWithoutRow = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/doc/wiki/orphan-on-disk.md`,
      aliceToken,
    );
    expect(fileWithoutRow.status).toBe(500);
    expect(fileWithoutRow.body).toEqual({
      detail: "Document on disk lacks a registry row: wiki/orphan-on-disk.md",
    });

    const invalid = await api("GET", `/vaults/${id.vaultAlpha}/doc/wiki/%5Cbad.md`, aliceToken);
    expect(invalid.status).toBe(400);

    const nonMember = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/doc/wiki/alpha-practice.md`,
      malloryToken,
    );
    expect(nonMember.status).toBe(403);

    const unauthenticated = await api("GET", `/vaults/${id.vaultAlpha}/doc/wiki/alpha-practice.md`);
    expect(unauthenticated.status).toBe(401);
  });

  it("reads chunk ranges with inclusive slicing, the 100 chunk cap, and authz", async () => {
    const { aliceToken, malloryToken } = currentFixture();
    const cappedQuery = new URLSearchParams({
      path: "raw/books/capital.md",
      start: "0",
      end: "200",
    });
    const capped = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/chunks?${cappedQuery.toString()}`,
      aliceToken,
    );
    expect(capped.status).toBe(200);
    const cappedChunks = asArray(capped.body).map(asRecord);
    expect(cappedChunks).toHaveLength(100);
    expect(cappedChunks[0]).toMatchObject({
      path: "raw/books/capital.md",
      chunk_index: 0,
      heading: "Opening",
      body: "Capital chunk 0",
      content_hash: "chunk-hash-0",
    });
    expect(cappedChunks.at(-1)).toMatchObject({ chunk_index: 99 });

    const tailQuery = new URLSearchParams({
      path: "raw/books/capital.md",
      start: "100",
      end: "200",
    });
    const tail = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/chunks?${tailQuery.toString()}`,
      aliceToken,
    );
    expect(tail.status).toBe(200);
    expect(asArray(tail.body).map((chunk) => asRecord(chunk).chunk_index)).toEqual([
      100, 101, 102, 103, 104,
    ]);

    const inverted = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/chunks?path=raw%2Fbooks%2Fcapital.md&start=7&end=3`,
      aliceToken,
    );
    expect(inverted.status).toBe(200);
    expect(inverted.body).toEqual([]);

    const missingPath = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/chunks?path=raw%2Fbooks%2Fmissing.md&start=0&end=3`,
      aliceToken,
    );
    expect(missingPath.status).toBe(200);
    expect(missingPath.body).toEqual([]);

    const negativeStart = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/chunks?path=raw%2Fbooks%2Fcapital.md&start=-1&end=1`,
      aliceToken,
    );
    expect(negativeStart.status).toBe(200);
    expect(
      (negativeStart.body as ReadonlyArray<{ chunk_index: number }>).map(
        (chunk) => chunk.chunk_index,
      ),
    ).toEqual([0, 1]);

    const invalidQuery = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/chunks?path=raw%2Fbooks%2Fcapital.md&start=0`,
      aliceToken,
    );
    expect(invalidQuery.status).toBe(422);

    const nonMember = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/chunks?${cappedQuery.toString()}`,
      malloryToken,
    );
    expect(nonMember.status).toBe(403);

    const unauthenticated = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/chunks?${cappedQuery.toString()}`,
    );
    expect(unauthenticated.status).toBe(401);
  });

  it("reads live wiki links with archived exclusions, 404s non-wiki paths, and enforces authz", async () => {
    const { aliceToken, malloryToken } = currentFixture();
    const alphaQuery = new URLSearchParams({ path: "wiki/alpha-practice.md" });
    const alphaLinks = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/links?${alphaQuery.toString()}`,
      aliceToken,
    );
    expect(alphaLinks.status).toBe(200);
    expect(alphaLinks.body).toEqual({
      outgoing: [
        {
          file_path: "wiki/beta-theory.md",
          title: "Beta Theory",
          precis: "Beta precis",
          updated_at: "2026-07-09T12:00:00.000Z",
          slug: "beta-theory",
        },
      ],
      incoming: [
        {
          file_path: "wiki/gamma-lines.md",
          title: "gamma Lines",
          precis: "Gamma precis",
          updated_at: "2026-07-08T12:00:00.000Z",
          slug: "gamma-lines",
        },
      ],
    });

    const betaQuery = new URLSearchParams({ path: "wiki/beta-theory.md" });
    const betaLinks = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/links?${betaQuery.toString()}`,
      aliceToken,
    );
    expect(betaLinks.status).toBe(200);
    expect(betaLinks.body).toMatchObject({
      outgoing: [],
      incoming: [{ file_path: "wiki/alpha-practice.md" }],
    });

    const rawQuery = new URLSearchParams({ path: "raw/books/capital.md" });
    const rawLinks = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/links?${rawQuery.toString()}`,
      aliceToken,
    );
    expect(rawLinks.status).toBe(404);
    expect(rawLinks.body).toEqual({ detail: "Not a wiki article: raw/books/capital.md" });

    const archivedQuery = new URLSearchParams({ path: "archive/archived-essay.md" });
    const archivedLinks = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/links?${archivedQuery.toString()}`,
      aliceToken,
    );
    expect(archivedLinks.status).toBe(404);

    const nonMember = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/links?${alphaQuery.toString()}`,
      malloryToken,
    );
    expect(nonMember.status).toBe(403);

    const unauthenticated = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/links?${alphaQuery.toString()}`,
    );
    expect(unauthenticated.status).toBe(401);
  });

  it("lists sessions self-scoped to the caller with pagination and authz", async () => {
    const { aliceToken, bobToken, malloryToken } = currentFixture();
    const listed = await api("GET", `/vaults/${id.vaultAlpha}/sessions`, aliceToken);
    expect(listed.status).toBe(200);
    const page = asPage(listed.body);
    const sessions = itemRecords(page);
    // The anchored thread (sessionAliceMain) lives with its document and is
    // excluded from the main list; unanchored and origin-less sessions stay.
    expect(page.pagination).toEqual({ limit: 50, offset: 0, total: 1 });
    expect(sessions.map((session) => session.id)).toEqual([id.sessionAliceOlder]);
    expect(sessions[0]).toMatchObject({
      id: id.sessionAliceOlder,
      query: "Earlier organizing question",
      user_id: id.alice,
      created_at: "2026-07-06T08:00:00.000Z",
      updated_at: "2026-07-06T08:05:00.000Z",
      origin: null,
    });

    const secondPage = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions?limit=1&offset=1`,
      aliceToken,
    );
    expect(secondPage.status).toBe(200);
    expect(itemRecords(asPage(secondPage.body)).map((session) => session.id)).toEqual([]);

    const zero = await api("GET", `/vaults/${id.vaultAlpha}/sessions?limit=0`, aliceToken);
    expect(zero.status).toBe(200);
    expect(asPage(zero.body)).toEqual({
      items: [],
      pagination: { limit: 0, offset: 0, total: 1 },
    });

    const bobList = await api("GET", `/vaults/${id.vaultAlpha}/sessions`, bobToken);
    expect(bobList.status).toBe(200);
    expect(asPage(bobList.body).pagination).toEqual({ limit: 50, offset: 0, total: 1 });
    expect(itemRecords(asPage(bobList.body)).map((session) => session.id)).toEqual([id.sessionBob]);

    const pastEnd = await api("GET", `/vaults/${id.vaultAlpha}/sessions?offset=99`, aliceToken);
    expect(pastEnd.status).toBe(200);
    expect(asPage(pastEnd.body)).toEqual({
      items: [],
      pagination: { limit: 50, offset: 99, total: 1 },
    });

    const overCap = await api("GET", `/vaults/${id.vaultAlpha}/sessions?limit=201`, aliceToken);
    expect(overCap.status).toBe(422);

    const nonMember = await api("GET", `/vaults/${id.vaultAlpha}/sessions`, malloryToken);
    expect(nonMember.status).toBe(403);

    const unauthenticated = await api("GET", `/vaults/${id.vaultAlpha}/sessions`);
    expect(unauthenticated.status).toBe(401);

    const bobVaultList = await api("GET", `/vaults/${id.vaultBeta}/sessions`, bobToken);
    expect(bobVaultList.status).toBe(200);
    expect(asPage(bobVaultList.body)).toEqual({
      items: [],
      pagination: { limit: 50, offset: 0, total: 0 },
    });
  });

  it("serves origin threads by-origin with events while the main list excludes anchored ones", async () => {
    const { aliceToken, bobToken, malloryToken } = currentFixture();
    const docPath = "refs/article.md";
    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(sessions)
          .values([
            {
              id: "s-origin-anchored",
              vaultId: id.vaultAlpha,
              userId: id.alice,
              query: "What does the anchored claim mean?",
              origin: {
                doc_path: docPath,
                origin_scope: "personal",
                anchor: "anchored claim",
                paragraph: "The anchored paragraph.",
                paragraph_index: 1,
              },
              createdAt: new Date("2026-07-10T08:00:00.000Z"),
              updatedAt: new Date("2026-07-10T08:10:00.000Z"),
            },
            {
              id: "s-origin-plain",
              vaultId: id.vaultAlpha,
              userId: id.alice,
              query: "Doc-initiated conversation",
              origin: {
                doc_path: docPath,
                origin_scope: "personal",
                anchor: null,
                paragraph: null,
                paragraph_index: null,
              },
              createdAt: new Date("2026-07-10T09:00:00.000Z"),
              updatedAt: new Date("2026-07-10T09:05:00.000Z"),
            },
            {
              id: "s-origin-bob",
              vaultId: id.vaultAlpha,
              userId: id.bob,
              query: "Bob's anchored thread",
              origin: {
                doc_path: docPath,
                origin_scope: "personal",
                anchor: "bob claim",
                paragraph: null,
                paragraph_index: null,
              },
              createdAt: new Date("2026-07-10T10:00:00.000Z"),
              updatedAt: new Date("2026-07-10T10:05:00.000Z"),
            },
          ]))
          .pipe(Effect.orDie);
      }),
    );
    await writeVaultFile(
      id.vaultAlpha,
      "sessions/s-origin-anchored.jsonl",
      jsonl([
        {
          type: "meta",
          id: "s-origin-anchored",
          query: "What does the anchored claim mean?",
          ts: "2026-07-10T08:00:00.000Z",
          user_id: id.alice,
          origin: {
            doc_path: docPath,
            origin_scope: "personal",
            anchor: "anchored claim",
            paragraph: "The anchored paragraph.",
            paragraph_index: 1,
          },
        },
        {
          type: "exchange",
          exId: "ex-origin-a",
          query: "What does the anchored claim mean?",
          thinking: [],
          answer: "It anchors the discussion.",
          ts: "2026-07-10T08:10:00.000Z",
        },
      ]),
    );
    await writeVaultFile(
      id.vaultAlpha,
      "sessions/s-origin-plain.jsonl",
      jsonl([
        {
          type: "meta",
          id: "s-origin-plain",
          query: "Doc-initiated conversation",
          ts: "2026-07-10T09:00:00.000Z",
          user_id: id.alice,
          origin: {
            doc_path: docPath,
            origin_scope: "personal",
            anchor: null,
            paragraph: null,
            paragraph_index: null,
          },
        },
        {
          type: "exchange",
          exId: "ex-origin-p",
          query: "Doc-initiated conversation",
          thinking: [],
          answer: "Plain conversation answer.",
          ts: "2026-07-10T09:05:00.000Z",
        },
      ]),
    );
    await writeVaultFile(
      id.vaultAlpha,
      "sessions/s-origin-bob.jsonl",
      jsonl([
        {
          type: "meta",
          id: "s-origin-bob",
          query: "Bob's anchored thread",
          ts: "2026-07-10T10:00:00.000Z",
          user_id: id.bob,
          origin: {
            doc_path: docPath,
            origin_scope: "personal",
            anchor: "bob claim",
            paragraph: null,
            paragraph_index: null,
          },
        },
      ]),
    );

    // The main list keeps unanchored origin sessions but drops anchored threads.
    const listed = await api("GET", `/vaults/${id.vaultAlpha}/sessions`, aliceToken);
    expect(listed.status).toBe(200);
    const listedIds = itemRecords(asPage(listed.body)).map((session) => session.id);
    expect(listedIds).toContain("s-origin-plain");
    expect(listedIds).not.toContain("s-origin-anchored");
    expect(listedIds).not.toContain("s-origin-bob");

    const byOrigin = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/by-origin?doc_path=${encodeURIComponent(docPath)}`,
      aliceToken,
    );
    expect(byOrigin.status).toBe(200);
    const details = asArray(byOrigin.body).map(asRecord);
    expect(details.map((detail) => asRecord(detail.session).id)).toEqual([
      "s-origin-anchored",
      "s-origin-plain",
    ]);
    expect(asRecord(details[0]?.session)).toMatchObject({
      id: "s-origin-anchored",
      user_id: id.alice,
      created_at: "2026-07-10T08:00:00.000Z",
      origin: {
        doc_path: docPath,
        origin_scope: "personal",
        anchor: "anchored claim",
        paragraph: "The anchored paragraph.",
        paragraph_index: 1,
      },
    });
    expect(
      asArray(details[0]?.events)
        .map(asRecord)
        .map((event) => event.exId)
        .filter(Boolean),
    ).toEqual(["ex-origin-a"]);
    expect(
      asArray(details[1]?.events)
        .map(asRecord)
        .map((event) => event.exId)
        .filter(Boolean),
    ).toEqual(["ex-origin-p"]);

    const bobOrigin = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/by-origin?doc_path=${encodeURIComponent(docPath)}`,
      bobToken,
    );
    expect(bobOrigin.status).toBe(200);
    expect(
      asArray(bobOrigin.body).map((detail) => asRecord(asRecord(detail).session).id),
    ).toEqual(["s-origin-bob"]);

    const otherPath = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/by-origin?doc_path=${encodeURIComponent("refs/other.md")}`,
      aliceToken,
    );
    expect(otherPath.status).toBe(200);
    expect(otherPath.body).toEqual([]);

    const nonMember = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/by-origin?doc_path=${encodeURIComponent(docPath)}`,
      malloryToken,
    );
    expect(nonMember.status).toBe(403);
  });

  it("rejects appends and markdown reads of another member's session", async () => {
    const { aliceToken, bobToken } = currentFixture();
    const append = await api(
      "PATCH",
      `/vaults/${id.vaultAlpha}/sessions/${id.sessionAliceMain}`,
      bobToken,
      { id: "ex-blocked", query: "Blocked?", thinking: [], answer: "" },
    );
    expect(append.status).toBe(404);
    expect(append.body).toEqual({ detail: "Session not found" });

    const markdown = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/${id.sessionAliceMain}/markdown`,
      bobToken,
    );
    expect(markdown.status).toBe(404);
    expect(markdown.body).toEqual({ detail: "Session not found" });

    const ownerAppend = await api(
      "PATCH",
      `/vaults/${id.vaultAlpha}/sessions/${id.sessionAliceMain}`,
      aliceToken,
      { id: "ex-owner", query: "Owner?", thinking: [], answer: "Yes." },
    );
    expect(ownerAppend.status).toBe(200);
  });

  it("replays sessions from JSONL with owner-only access and path-safe ids", async () => {
    const { aliceToken, bobToken, malloryToken } = currentFixture();
    const replay = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/${id.sessionAliceMain}`,
      aliceToken,
    );
    expect(replay.status).toBe(200);
    const body = asRecord(replay.body);
    expect(body.id).toBe(id.sessionAliceMain);
    const events = asArray(body.events).map(asRecord);
    expect(events.map((event) => event.type)).toEqual(["meta", "exchange", "btw", "exchange"]);
    expect(events.map((event) => event.exId).filter(Boolean)).not.toContain("ex-stale");
    expect(events[0]).toMatchObject({
      type: "meta",
      query: "How should study circles use source material?",
      user_id: id.alice,
      origin: {
        doc_path: "wiki/alpha-practice.md",
        anchor: "alpha-anchor",
        paragraph: "Alpha paragraph",
        paragraph_index: 2,
      },
    });
    const firstExchange = events[1] ?? {};
    const thinking = asArray(firstExchange.thinking).map(asRecord);
    const sources = asArray(thinking[0]?.sources).map(asRecord);
    expect(sources.map((source) => source.type)).toEqual([
      "article",
      "raw",
      "search",
      "query",
      "links",
    ]);
    expect(sources[2]).toMatchObject({
      label: "Search: pedagogy",
      thinking: null,
      ranges: [],
      full: false,
    });
    const btw = events[2] ?? {};
    expect(btw).toMatchObject({
      type: "btw",
      exId: "ex-1",
      quote: "concrete passage",
      blockOffset: 0,
      context: "Start with a concrete passage",
    });
    expect(asArray(btw.exchanges)).toHaveLength(2);

    // Sessions are personal: a vault member cannot read another member's session.
    const memberReadsOwnerSession = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/${id.sessionAliceMain}`,
      bobToken,
    );
    expect(memberReadsOwnerSession.status).toBe(404);
    expect(memberReadsOwnerSession.body).toEqual({ detail: "Session not found" });

    const ownerReadsMemberSession = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/${id.sessionBob}`,
      aliceToken,
    );
    expect(ownerReadsMemberSession.status).toBe(404);

    const nonMember = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/${id.sessionAliceMain}`,
      malloryToken,
    );
    expect(nonMember.status).toBe(403);

    const missingEvents = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/s-missing`,
      aliceToken,
    );
    expect(missingEvents.status).toBe(404);
    expect(missingEvents.body).toEqual({ detail: "Session not found" });

    const traversal = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/${encodeURIComponent("s-2\\..")}`,
      aliceToken,
    );
    expect(traversal.status).toBe(422);
    expect(traversal.body).toEqual({ detail: "Invalid path parameter" });

    const unauthenticated = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/${id.sessionAliceMain}`,
    );
    expect(unauthenticated.status).toBe(401);
  });

  it("skips invalid typed session events and truncates at malformed JSON", async () => {
    const { aliceToken } = currentFixture();
    const replay = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/${id.sessionMalformed}`,
      aliceToken,
    );
    expect(replay.status).toBe(200);
    const events = asArray(asRecord(replay.body).events).map(asRecord);
    expect(events.map((event) => event.type)).toEqual(["meta", "exchange", "exchange"]);
    expect(events.map((event) => event.exId).filter(Boolean)).toEqual([
      "ex-good",
      "ex-after-invalid",
    ]);
    expect(events.map((event) => event.exId).filter(Boolean)).not.toContain("ex-after-bad-json");

    await writeVaultFile(id.vaultAlpha, "sessions/s-empty.jsonl", "");
    const emptyReplay = await api("GET", `/vaults/${id.vaultAlpha}/sessions/s-empty`, aliceToken);
    expect(emptyReplay.status).toBe(200);
    expect(emptyReplay.body).toEqual({ id: "s-empty", events: [], origin_title: null });

    const crossVault = await api(
      "GET",
      `/vaults/${id.vaultBeta}/sessions/${id.sessionAliceMain}`,
      currentFixture().bobToken,
    );
    expect(crossVault.status).toBe(404);
    expect(crossVault.body).toEqual({ detail: "Session not found" });
  });

  it("serves pre-rendered session markdown with decided 404 for missing sidecars", async () => {
    const { aliceToken, malloryToken } = currentFixture();
    const response = await rawApi(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/${id.sessionAliceMain}/markdown`,
      aliceToken,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(await response.text()).toBe(
      "# Stored Session Markdown\n\nThis came from the sidecar.\n",
    );

    const missingSidecar = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/${id.sessionNoMarkdown}/markdown`,
      aliceToken,
    );
    expect(missingSidecar.status).toBe(404);
    expect(missingSidecar.body).toEqual({ detail: "Session markdown not found" });

    const nonMember = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/${id.sessionAliceMain}/markdown`,
      malloryToken,
    );
    expect(nonMember.status).toBe(403);

    const unauthenticated = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/sessions/${id.sessionAliceMain}/markdown`,
    );
    expect(unauthenticated.status).toBe(401);
  });

  it("lists raw sources with search, source-type facets, nullability, and authz", async () => {
    const { aliceToken, malloryToken } = currentFixture();
    const listed = await api("GET", `/vaults/${id.vaultAlpha}/raw/sources`, aliceToken);
    expect(listed.status).toBe(200);
    const page = asPage(listed.body);
    const sources = itemRecords(page);
    expect(page.pagination).toEqual({ limit: 50, offset: 0, total: 4 });
    expect(sources.map((source) => source.file_path)).toEqual([
      "raw/books/capital.md",
      "raw/articles/organization.md",
      "raw/speeches/mass-strike.md",
      "raw/books/encoded title.md",
    ]);
    const speech = sources.find((source) => source.file_path === "raw/speeches/mass-strike.md");
    expect(speech).toMatchObject({
      title: null,
      url: null,
      origin: null,
      genre: null,
      tags: [],
      derived_extras: {},
    });
    const facets = asRecord(listed.body).facets as {
      source_types: ReadonlyArray<{ value: string; count: number }>;
    };
    expect([...facets.source_types].sort((a, b) => a.value.localeCompare(b.value))).toEqual([
      { value: "article", count: 1 },
      { value: "book", count: 2 },
      { value: "speech", count: 1 },
    ]);

    const searched = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/raw/sources?search=Marx`,
      aliceToken,
    );
    expect(searched.status).toBe(200);
    expect(itemRecords(asPage(searched.body)).map((source) => source.file_path)).toEqual([
      "raw/books/capital.md",
    ]);
    expect(asPage(searched.body).pagination.total).toBe(1);
    const searchedFacets = asRecord(searched.body).facets as {
      source_types: ReadonlyArray<{ value: string; count: number }>;
    };
    expect([...searchedFacets.source_types].sort((a, b) => a.value.localeCompare(b.value))).toEqual(
      [
        { value: "article", count: 1 },
        { value: "book", count: 2 },
        { value: "speech", count: 1 },
      ],
    );

    const emptyParams = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/raw/sources?search=&source_type=`,
      aliceToken,
    );
    expect(emptyParams.status).toBe(200);
    expect(asPage(emptyParams.body).pagination.total).toBe(4);

    const filtered = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/raw/sources?source_type=article`,
      aliceToken,
    );
    expect(filtered.status).toBe(200);
    expect(itemRecords(asPage(filtered.body)).map((source) => source.source_type)).toEqual([
      "article",
    ]);
    expect(asPage(filtered.body).pagination.total).toBe(1);

    const byTag = await api("GET", `/vaults/${id.vaultAlpha}/raw/sources?tag=party`, aliceToken);
    expect(byTag.status).toBe(200);
    expect(itemRecords(asPage(byTag.body)).map((source) => source.file_path)).toEqual([
      "raw/articles/organization.md",
    ]);
    expect(asPage(byTag.body).pagination.total).toBe(1);
    const byTagFacets = asRecord(byTag.body).facets as {
      source_types: ReadonlyArray<{ value: string; count: number }>;
    };
    expect(byTagFacets.source_types).toEqual([{ value: "article", count: 1 }]);

    const byTagCase = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/raw/sources?tag=ECONOMICS`,
      aliceToken,
    );
    expect(byTagCase.status).toBe(200);
    expect(itemRecords(asPage(byTagCase.body)).map((source) => source.file_path)).toEqual([
      "raw/books/capital.md",
    ]);
    expect(asPage(byTagCase.body).pagination.total).toBe(1);

    const tagComposed = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/raw/sources?tag=party&source_type=article`,
      aliceToken,
    );
    expect(tagComposed.status).toBe(200);
    expect(itemRecords(asPage(tagComposed.body)).map((source) => source.file_path)).toEqual([
      "raw/articles/organization.md",
    ]);
    expect(asPage(tagComposed.body).pagination.total).toBe(1);

    const tagComposedMiss = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/raw/sources?tag=party&source_type=book`,
      aliceToken,
    );
    expect(tagComposedMiss.status).toBe(200);
    expect(asPage(tagComposedMiss.body).items).toEqual([]);
    expect(asPage(tagComposedMiss.body).pagination.total).toBe(0);

    const tagSearched = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/raw/sources?tag=party&search=Lenin`,
      aliceToken,
    );
    expect(tagSearched.status).toBe(200);
    expect(itemRecords(asPage(tagSearched.body)).map((source) => source.file_path)).toEqual([
      "raw/articles/organization.md",
    ]);
    expect(asPage(tagSearched.body).pagination.total).toBe(1);

    const tagNoMatch = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/raw/sources?tag=absent`,
      aliceToken,
    );
    expect(tagNoMatch.status).toBe(200);
    expect(asPage(tagNoMatch.body).items).toEqual([]);
    expect(asPage(tagNoMatch.body).pagination.total).toBe(0);

    const zero = await api("GET", `/vaults/${id.vaultAlpha}/raw/sources?limit=0`, aliceToken);
    expect(zero.status).toBe(200);
    expect(asPage(zero.body)).toEqual({
      items: [],
      pagination: { limit: 0, offset: 0, total: 4 },
    });

    const cap = await api("GET", `/vaults/${id.vaultAlpha}/raw/sources?limit=200`, aliceToken);
    expect(cap.status).toBe(200);
    expect(asPage(cap.body).pagination.limit).toBe(200);

    const pastEnd = await api("GET", `/vaults/${id.vaultAlpha}/raw/sources?offset=99`, aliceToken);
    expect(pastEnd.status).toBe(200);
    expect(asPage(pastEnd.body).items).toEqual([]);

    const overCap = await api("GET", `/vaults/${id.vaultAlpha}/raw/sources?limit=201`, aliceToken);
    expect(overCap.status).toBe(422);

    const nonMember = await api("GET", `/vaults/${id.vaultAlpha}/raw/sources`, malloryToken);
    expect(nonMember.status).toBe(403);

    const unauthenticated = await api("GET", `/vaults/${id.vaultAlpha}/raw/sources`);
    expect(unauthenticated.status).toBe(401);
  });
});
