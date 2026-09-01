import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server as NodeServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  authCodes,
  compileCacheEntries,
  compileIntents,
  Database,
  fileIngestBatches,
  fileIngestFiles,
  ideas,
  llmCostEvents,
  pipelineRuns,
  searchIndex,
  sessions,
  shares,
  sourceDeletionOutbox,
  sourceDocuments,
  sourceProposals,
  tasks,
  topicMembership,
  topics,
  urlIngestRequests,
  userDocuments,
  users,
  vaultMemberships,
  vaults,
  wikiArticles,
} from "@great-minds/database";
import type { ExchangeData, SessionOrigin, Uuid } from "@great-minds/domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Effect, Layer, Option, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeAppLayer } from "../src/app-layer.ts";
import { ClockService, makeTestClock } from "../src/clock.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { bodyContentHash, fileContentHash, rawFileHash } from "../src/crypto.ts";
import { FileIngestBatches } from "../src/file-ingest-batches.ts";
import { StructuredLogger, StructuredLoggerLive } from "../src/logging.ts";
import { makeTestMailer } from "../src/mailer.ts";
import { parseFrontmatter } from "../src/markdown.ts";
import { makeTestRandomBytes } from "../src/random.ts";
import { startServer } from "../src/server.ts";
import { SessionsService } from "../src/sessions.ts";
import { SourceDocumentsService } from "../src/source-documents.ts";
import { sourceIdForKey } from "../src/source-identity.ts";
import { TokenService } from "../src/tokens.ts";
import { UrlIngestService } from "../src/url-ingest.ts";

const initialTime = new Date("2026-07-10T12:00:00.000Z");

const id = {
  alice: "00000000-0000-4000-8000-000000010001",
  bob: "00000000-0000-4000-8000-000000010002",
  carol: "00000000-0000-4000-8000-000000010003",
  mallory: "00000000-0000-4000-8000-000000010004",
  vault: "00000000-0000-4000-8000-000000010101",
  source: "00000000-0000-4000-8000-000000010501",
  conflictingProposal: "00000000-0000-4000-8000-000000010601",
  topic: "00000000-0000-4000-8000-000000010301",
  ideaOne: "00000000-0000-4000-8000-000000010701",
  ideaTwo: "00000000-0000-4000-8000-000000010702",
  run: "00000000-0000-4000-8000-000000010801",
  task: "00000000-0000-4000-8000-000000010901",
  cache: "00000000-0000-4000-8000-000000011001",
  cost: "00000000-0000-4000-8000-000000011101",
  session: "00000000-0000-4000-8000-000000011201",
  sessionShare: "00000000-0000-4000-8000-000000011301",
  referenceShare: "00000000-0000-4000-8000-000000011302",
  reference: "00000000-0000-4000-8000-000000011401",
  m32SourceA: "00000000-0000-4000-8000-000000013001",
  m32SourceB: "00000000-0000-4000-8000-000000013002",
  m32StagedRun: "00000000-0000-4000-8000-000000013101",
  m32StagedRunOther: "00000000-0000-4000-8000-000000013108",
  m32UrlRun: "00000000-0000-4000-8000-000000013102",
  m32UrlFailRun: "00000000-0000-4000-8000-000000013103",
  m32UrlPdfRun: "00000000-0000-4000-8000-000000013104",
  m32UrlCollisionA: "00000000-0000-4000-8000-000000013105",
  m32UrlCollisionB: "00000000-0000-4000-8000-000000013106",
  m32UrlReplayRun: "00000000-0000-4000-8000-000000013107",
  m32UrlRetryRun: "00000000-0000-4000-8000-000000013108",
  m32UrlReconcileRun: "00000000-0000-4000-8000-000000013109",
  m32UrlSlowRun: "00000000-0000-4000-8000-000000013110",
} as const;

type TestServices =
  | AppConfig
  | Database
  | ClockService
  | FileIngestBatches
  | SessionsService
  | SourceDocumentsService
  | StructuredLogger
  | TokenService
  | UrlIngestService;

type TestState = {
  readonly started: Awaited<ReturnType<typeof startServer>>;
  readonly clock: ReturnType<typeof makeTestClock>;
  readonly random: ReturnType<typeof makeTestRandomBytes>;
  readonly mailer: ReturnType<typeof makeTestMailer>;
  readonly storageRoot: string;
};

type Fixture = {
  readonly aliceToken: string;
  readonly bobToken: string;
  readonly carolToken: string;
  readonly malloryToken: string;
};

type ApiResponse = {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
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
  r2BucketName: Option.none(),
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
  allowPrivateUrlFetch: true,
  serverHost: "127.0.0.1",
  serverPort: 0,
});

const buildTestState = async () => {
  const clock = makeTestClock(initialTime);
  const random = makeTestRandomBytes();
  const mailer = makeTestMailer();
  const storageRoot = await mkdtemp(join(tmpdir(), "great-minds-write-storage-"));
  const configLayer = Layer.succeed(AppConfig, testConfig(databaseUrl(), storageRoot));
  const appLayer = makeAppLayer({
    config: configLayer,
    clock: clock.layer,
    mailer: mailer.layer,
    logger: StructuredLoggerLive,
    randomBytes: random.layer,
  });
  const started = await startServer({ layer: appLayer, host: "127.0.0.1", port: 0 });
  return { started, clock, random, mailer, storageRoot } satisfies TestState;
};

const runDb = <A>(effect: Effect.Effect<A, unknown, TestServices>) =>
  currentState().started.runtime.runPromise(effect);

const createSessionForTest = (
  userId: Uuid,
  idempotencyKey: string,
  exchange: ExchangeData,
  origin?: SessionOrigin,
) =>
  runDb(
    Effect.gen(function* () {
      const sessions = yield* SessionsService;
      return yield* sessions.createSession(userId, id.vault as Uuid, {
        idempotencyKey,
        exchange,
        ...(origin === undefined ? {} : { origin }),
      });
    }),
  );

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

const readVaultFile = (vaultId: string, path: string) =>
  readFile(join(currentState().storageRoot, "vaults", vaultId, path), "utf8");

const readUserFile = (userId: string, path: string) =>
  readFile(join(currentState().storageRoot, "users", userId, path), "utf8");

const fileExists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const vaultFileExists = (vaultId: string, path: string) =>
  fileExists(join(currentState().storageRoot, "vaults", vaultId, path));

const userFileExists = (userId: string, path: string) =>
  fileExists(join(currentState().storageRoot, "users", userId, path));

const proposalFileExists = (proposalId: string) =>
  fileExists(join(currentState().storageRoot, "proposals", `${proposalId}.md`));

const issueToken = (userId: string) =>
  runDb(
    Effect.gen(function* () {
      const tokens = yield* TokenService;
      return yield* tokens.issueAccessToken(userId as Uuid, initialTime);
    }),
  );

const seedBase = async (): Promise<Fixture> => {
  await runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d
        .insert(users)
        .values([
          { id: id.alice, email: "alice@example.com", createdAt: initialTime },
          { id: id.bob, email: "bob@example.com", createdAt: initialTime },
          { id: id.carol, email: "carol@example.com", createdAt: initialTime },
          { id: id.mallory, email: "mallory@example.com", createdAt: initialTime },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(vaults)
        .values({
          id: id.vault,
          name: "Alpha Vault",
          ownerId: id.alice,
          createdAt: initialTime,
        }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(vaultMemberships)
        .values([
          {
            id: "00000000-0000-4000-8000-000000012001",
            vaultId: id.vault,
            userId: id.alice,
            role: "OWNER",
          },
          {
            id: "00000000-0000-4000-8000-000000012002",
            vaultId: id.vault,
            userId: id.bob,
            role: "EDITOR",
          },
          {
            id: "00000000-0000-4000-8000-000000012003",
            vaultId: id.vault,
            userId: id.carol,
            role: "VIEWER",
          },
        ]))
        .pipe(Effect.orDie);
    }),
  );
  return {
    aliceToken: await issueToken(id.alice),
    bobToken: await issueToken(id.bob),
    carolToken: await issueToken(id.carol),
    malloryToken: await issueToken(id.mallory),
  };
};

const seedSourceGraph = async () => {
  await writeVaultFile(
    id.vault,
    "raw/books/capital.md",
    "---\nsource_type: book\ntitle: Capital\n---\nCapital body.\n",
  );
  await runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d
        .insert(sourceDocuments)
        .values({
          id: id.source,
          vaultId: id.vault,
          filePath: "raw/books/capital.md",
          fileHash: "file-hash",
          bodyHash: "body-hash",
          sourceType: "book",
          title: "Capital",
          tags: [],
          derivedExtras: {},
        }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(topics)
        .values({
          topicId: id.topic,
          vaultId: id.vault,
          slug: "capital",
          title: "Capital",
          description: "Capital",
        }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(ideas)
        .values([
          {
            ideaId: id.ideaOne,
            vaultId: id.vault,
            documentId: id.source,
            kind: "concept",
            label: "value",
            description: "Value",
          },
          {
            ideaId: id.ideaTwo,
            vaultId: id.vault,
            documentId: id.source,
            kind: "concept",
            label: "labor",
            description: "Labor",
          },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(topicMembership)
        .values([
          { topicId: id.topic, ideaId: id.ideaOne },
          { topicId: id.topic, ideaId: id.ideaTwo },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(searchIndex)
        .values({
          vaultId: id.vault,
          path: "raw/books/capital.md",
          chunkIndex: 0,
          heading: "Capital",
          body: "Capital body",
          contentHash: "chunk-hash",
          tsv: sql`to_tsvector('english', 'Capital body')`,
        }))
        .pipe(Effect.orDie);
    }),
  );
};

const api = async (
  method: string,
  path: string,
  bearer?: string,
  body?: unknown,
): Promise<ApiResponse> => {
  return apiAt(currentState().started.url, method, `/v1${path}`, bearer, body);
};

const apiAt = async (
  baseUrl: string,
  method: string,
  path: string,
  bearer?: string,
  body?: unknown,
): Promise<ApiResponse> => {
  const headers = new Headers();
  if (bearer !== undefined) {
    headers.set("authorization", `Bearer ${bearer}`);
  }
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? undefined : (JSON.parse(text) as unknown),
    text,
  };
};

const uploadApi = async (
  path: string,
  bearer: string | undefined,
  form: FormData,
): Promise<ApiResponse> => {
  const headers = new Headers();
  if (bearer !== undefined) {
    headers.set("authorization", `Bearer ${bearer}`);
  }
  const response = await fetch(`${currentState().started.url}/v1${path}`, {
    method: "POST",
    headers,
    body: form,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? undefined : (JSON.parse(text) as unknown),
    text,
  };
};

const withLocalHttpServer = async <A>(
  handler: RequestListener,
  use: (baseUrl: string) => Promise<A>,
) => {
  const server: NodeServer = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("local HTTP test server did not bind to a TCP port");
    }
    return await use(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
};

const waitForPipelineRun = async (
  runId: string,
  predicate: (row: typeof pipelineRuns.$inferSelect) => boolean,
  timeoutMs: number = 10_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select()
          .from(pipelineRuns)
          .where(eq(pipelineRuns.id, runId)))
          .pipe(Effect.orDie);
      }),
    );
    const row = rows[0];
    if (row !== undefined && predicate(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for pipeline run ${runId}`);
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object response");
  }
  return value as Record<string, unknown>;
};

const asArray = (value: unknown): Array<Record<string, unknown>> => {
  if (!Array.isArray(value)) {
    throw new Error("expected array response");
  }
  return value.map(asRecord);
};

const jsonl = (events: readonly unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n");

const countTable = <A>(table: A) =>
  runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      const rows = yield* db.query((d) => d
        .select({ total: sql<number>`count(*)::int` })
        .from(table as never))
        .pipe(Effect.orDie);
      return rows[0]?.total ?? 0;
    }),
  );

const waitFor = async <A>(
  load: () => Promise<A>,
  ready: (value: A) => boolean,
  timeoutMs = 10_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await load();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
};

describe("M3.1 write endpoint integration", () => {
  beforeAll(async () => {
    state = await buildTestState();
  });

  beforeEach(async () => {
    const current = currentState();
    current.clock.set(initialTime);
    current.random.reset();
    current.mailer.sent.length = 0;
    await resetDatabase();
    await resetStorage();
    fixture = await seedBase();
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

  it("creates vaults, seeds config conditionally, and updates config only for owners", async () => {
    const { aliceToken, bobToken } = currentFixture();
    const created = await api("POST", "/vaults", aliceToken, {
      name: "New Project",
      thematic_hint: "Prefer movement debates.",
      kinds: ["movement", "debate"],
    });
    expect(created.status).toBe(201);
    const createdBody = asRecord(created.body);
    const createdVaultId = String(createdBody.id);
    expect(createdBody).toMatchObject({
      name: "New Project",
      owner_id: id.alice,
    });
    expect(await readVaultFile(createdVaultId, "config.yaml")).toContain(
      "Prefer movement debates.",
    );

    await writeVaultFile(
      id.vault,
      "config.yaml",
      "thematic_hint: Old\nkinds:\n  - person\nweb_search: true\nmetadata:\n  tradition:\n    type: string\n",
    );
    const updated = await api("PATCH", `/vaults/${id.vault}/config`, aliceToken, {
      thematic_hint: "New steer",
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({
      thematic_hint: "New steer",
      kinds: ["person"],
    });
    const configText = await readVaultFile(id.vault, "config.yaml");
    expect(configText).toContain("web_search: true");
    expect(configText).toContain("metadata:");

    const denied = await api("PATCH", `/vaults/${id.vault}/config`, bobToken, {
      thematic_hint: "Editor steer",
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ detail: "Only vault owners can perform this action" });
  });

  it("manages members with owner guards, invite role limits, 404s, and ownership transfer", async () => {
    const { aliceToken, bobToken } = currentFixture();
    const invalidInvite = await api("POST", `/vaults/${id.vault}/members`, aliceToken, {
      email: "new@example.com",
      role: "owner",
    });
    expect(invalidInvite.status).toBe(422);

    const invited = await api("POST", `/vaults/${id.vault}/members`, aliceToken, {
      email: "New@Example.com",
      role: "viewer",
    });
    expect(invited.status).toBe(201);
    expect(invited.body).toMatchObject({ email: "new@example.com", role: "viewer" });
    expect(currentState().mailer.sent).toHaveLength(1);

    const existingInvite = await api("POST", `/vaults/${id.vault}/members`, aliceToken, {
      email: "bob@example.com",
      role: "viewer",
    });
    expect(existingInvite.status).toBe(201);
    expect(existingInvite.body).toMatchObject({ email: "bob@example.com", role: "viewer" });
    const bobMemberships = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select({ role: vaultMemberships.role })
          .from(vaultMemberships)
          .where(and(eq(vaultMemberships.vaultId, id.vault), eq(vaultMemberships.userId, id.bob))))
          .pipe(Effect.orDie);
      }),
    );
    expect(bobMemberships).toEqual([{ role: "EDITOR" }]);

    const editorDenied = await api("POST", `/vaults/${id.vault}/members`, bobToken, {
      email: "other@example.com",
      role: "editor",
    });
    expect(editorDenied.status).toBe(403);

    const missingUser = await api(
      "PUT",
      `/vaults/${id.vault}/members/00000000-0000-4000-8000-000000019999`,
      aliceToken,
      { role: "viewer" },
    );
    expect(missingUser.status).toBe(404);
    expect(missingUser.body).toMatchObject({ detail: "User not found" });

    const nonMember = await api("PUT", `/vaults/${id.vault}/members/${id.mallory}`, aliceToken, {
      role: "viewer",
    });
    expect(nonMember.status).toBe(404);
    expect(nonMember.body).toMatchObject({ detail: "User is not a member of this vault" });

    const changed = await api("PUT", `/vaults/${id.vault}/members/${id.bob}`, aliceToken, {
      role: "viewer",
    });
    expect(changed.status).toBe(200);
    expect(asRecord(changed.body).role).toBe("viewer");

    const removed = await api("DELETE", `/vaults/${id.vault}/members/${id.carol}`, aliceToken);
    expect(removed.status).toBe(204);
    const removedAgain = await api("DELETE", `/vaults/${id.vault}/members/${id.carol}`, aliceToken);
    expect(removedAgain.status).toBe(404);

    await api("PUT", `/vaults/${id.vault}/members/${id.bob}`, aliceToken, { role: "editor" });
    const selfTransfer = await api("POST", `/vaults/${id.vault}/transfer-ownership`, aliceToken, {
      new_owner_user_id: id.alice,
    });
    expect(selfTransfer.status).toBe(400);

    const transferred = await api("POST", `/vaults/${id.vault}/transfer-ownership`, aliceToken, {
      new_owner_user_id: id.bob,
    });
    expect(transferred.status).toBe(204);
    const roles = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select({ userId: vaultMemberships.userId, role: vaultMemberships.role })
          .from(vaultMemberships)
          .where(eq(vaultMemberships.vaultId, id.vault)))
          .pipe(Effect.orDie);
      }),
    );
    expect(Object.fromEntries(roles.map((row) => [row.userId, row.role]))).toMatchObject({
      [id.alice]: "EDITOR",
      [id.bob]: "OWNER",
    });
  });

  it("returns 403 to non-members on new vault write endpoints", async () => {
    const { malloryToken } = currentFixture();
    await seedSourceGraph();

    const responses = await Promise.all([
      api("PATCH", `/vaults/${id.vault}/config`, malloryToken, { thematic_hint: "Denied" }),
      api("POST", `/vaults/${id.vault}/members`, malloryToken, {
        email: "blocked@example.com",
        role: "editor",
      }),
      api("PUT", `/vaults/${id.vault}/members/${id.bob}`, malloryToken, { role: "viewer" }),
      api("DELETE", `/vaults/${id.vault}/members/${id.carol}`, malloryToken),
      api("POST", `/vaults/${id.vault}/transfer-ownership`, malloryToken, {
        new_owner_user_id: id.bob,
      }),
      api("DELETE", `/vaults/${id.vault}`, malloryToken),
      api("POST", `/vaults/${id.vault}/proposals`, malloryToken, {
        content: "blocked",
        content_type: "texts",
      }),
      api("GET", `/vaults/${id.vault}/proposals`, malloryToken),
      api("DELETE", `/vaults/${id.vault}/raw/sources/${id.source}`, malloryToken),
      api("POST", `/vaults/${id.vault}/raw/sources/${id.source}/deletion-request`, malloryToken),
    ]);

    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: responses.length }, () => 403),
    );
  });

  it("creates, lists, gets, approves, rejects, and guards source proposals", async () => {
    const { aliceToken, bobToken, carolToken } = currentFixture();
    const viewerCreate = await api("POST", `/vaults/${id.vault}/proposals`, carolToken, {
      content: "viewer proposal",
      content_type: "texts",
    });
    expect(viewerCreate.status).toBe(403);

    const created = await api("POST", `/vaults/${id.vault}/proposals`, bobToken, {
      content: "A proposed source body.",
      content_type: "texts",
      title: "Proposed Source",
      author: "Editor",
    });
    expect(created.status).toBe(201);
    const proposal = asRecord(created.body);
    const proposalId = String(proposal.id);
    expect(proposal).toMatchObject({
      vault_id: id.vault,
      status: "pending",
      title: "Proposed Source",
      author: "Editor",
      content_type: "texts",
    });
    expect(await proposalFileExists(proposalId)).toBe(true);

    const listed = await api("GET", `/vaults/${id.vault}/proposals?status=pending`, carolToken);
    expect(listed.status).toBe(200);
    expect(asRecord(listed.body).pagination).toMatchObject({ total: 1 });

    const fetched = await api("GET", `/vaults/${id.vault}/proposals/${proposalId}`, carolToken);
    expect(fetched.status).toBe(200);
    expect(asRecord(fetched.body).id).toBe(proposalId);

    const editorReview = await api(
      "PATCH",
      `/vaults/${id.vault}/proposals/${proposalId}`,
      bobToken,
      { status: "approved" },
    );
    expect(editorReview.status).toBe(403);

    const approved = await api("PATCH", `/vaults/${id.vault}/proposals/${proposalId}`, aliceToken, {
      status: "approved",
    });
    expect(approved.status).toBe(200);
    expect(asRecord(approved.body).status).toBe("approved");
    const destPath = String(asRecord(approved.body).dest_path);
    expect(await vaultFileExists(id.vault, destPath)).toBe(true);
    expect(await proposalFileExists(proposalId)).toBe(true);
    expect(await countTable(compileIntents)).toBe(1);
    expect(await countTable(sourceDocuments)).toBe(1);

    const secondCreate = await api("POST", `/vaults/${id.vault}/proposals`, bobToken, {
      content: "A second proposed source body.",
      content_type: "texts",
      title: "Second Proposed Source",
    });
    expect(secondCreate.status).toBe(201);
    const secondProposalId = String(asRecord(secondCreate.body).id);
    const secondApproved = await api(
      "PATCH",
      `/vaults/${id.vault}/proposals/${secondProposalId}`,
      aliceToken,
      { status: "approved" },
    );
    expect(secondApproved.status).toBe(200);
    const pendingIntents = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select({
            id: compileIntents.id,
            pipelineRunId: compileIntents.pipelineRunId,
            dispatchedAt: compileIntents.dispatchedAt,
          })
          .from(compileIntents)
          .where(and(eq(compileIntents.vaultId, id.vault), isNull(compileIntents.dispatchedAt))))
          .pipe(Effect.orDie);
      }),
    );
    expect(pendingIntents).toHaveLength(1);
    expect(pendingIntents[0]?.pipelineRunId).toBeNull();

    const reviewedAgain = await api(
      "PATCH",
      `/vaults/${id.vault}/proposals/${proposalId}`,
      aliceToken,
      { status: "rejected" },
    );
    expect(reviewedAgain.status).toBe(409);

    const rejectCreate = await api("POST", `/vaults/${id.vault}/proposals`, bobToken, {
      content: "Reject me.",
      content_type: "texts",
    });
    const rejectId = String(asRecord(rejectCreate.body).id);
    const rejected = await api("PATCH", `/vaults/${id.vault}/proposals/${rejectId}`, aliceToken, {
      status: "rejected",
    });
    expect(rejected.status).toBe(200);
    expect(await proposalFileExists(rejectId)).toBe(false);
  });

  it("deletes sources directly and through idempotent editor deletion requests", async () => {
    const { aliceToken, bobToken, carolToken } = currentFixture();
    await seedSourceGraph();

    const viewerRequest = await api(
      "POST",
      `/vaults/${id.vault}/raw/sources/${id.source}/deletion-request`,
      carolToken,
    );
    expect(viewerRequest.status).toBe(403);
    expect(viewerRequest.body).toMatchObject({ detail: "Viewers cannot request source deletion" });

    const ownerRequest = await api(
      "POST",
      `/vaults/${id.vault}/raw/sources/${id.source}/deletion-request`,
      aliceToken,
    );
    expect(ownerRequest.status).toBe(400);

    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(sourceProposals)
          .values({
            id: id.conflictingProposal,
            vaultId: id.vault,
            userId: id.bob,
            status: "PENDING",
            contentType: "user_suggestion",
            title: "Conflicting proposal",
            destPath: "raw/books/capital.md",
            sourceId: id.source,
          }))
          .pipe(Effect.orDie);
      }),
    );
    const conflict = await api(
      "POST",
      `/vaults/${id.vault}/raw/sources/${id.source}/deletion-request`,
      bobToken,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ detail: "A pending proposal already targets this source" });
    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .delete(sourceProposals)
          .where(eq(sourceProposals.id, id.conflictingProposal)))
          .pipe(Effect.orDie);
      }),
    );

    const request = await api(
      "POST",
      `/vaults/${id.vault}/raw/sources/${id.source}/deletion-request`,
      bobToken,
    );
    expect(request.status).toBe(201);
    const deletionProposalId = String(asRecord(request.body).id);
    const duplicate = await api(
      "POST",
      `/vaults/${id.vault}/raw/sources/${id.source}/deletion-request`,
      bobToken,
    );
    expect(duplicate.status).toBe(201);
    expect(asRecord(duplicate.body).id).toBe(deletionProposalId);

    const approved = await api(
      "PATCH",
      `/vaults/${id.vault}/proposals/${deletionProposalId}`,
      aliceToken,
      { status: "approved" },
    );
    expect(approved.status).toBe(200);
    expect(await countTable(sourceDocuments)).toBe(0);
    expect(await countTable(ideas)).toBe(0);
    expect(await countTable(topicMembership)).toBe(0);
    expect(await countTable(searchIndex)).toBe(0);
    expect(await vaultFileExists(id.vault, "raw/books/capital.md")).toBe(false);
    expect(await proposalFileExists(deletionProposalId)).toBe(false);
    expect(await countTable(compileIntents)).toBe(0);
    expect(await countTable(sourceDeletionOutbox)).toBe(1);

    await resetDatabase();
    await resetStorage();
    fixture = await seedBase();
    const { aliceToken: freshAliceToken } = currentFixture();
    await seedSourceGraph();
    const deleted = await api(
      "DELETE",
      `/vaults/${id.vault}/raw/sources/${id.source}`,
      freshAliceToken,
    );
    expect(deleted.status).toBe(204);
    expect(await countTable(sourceDocuments)).toBe(0);
    expect(await countTable(ideas)).toBe(0);
    expect(await countTable(topicMembership)).toBe(0);
    expect(await countTable(searchIndex)).toBe(0);
    expect(await vaultFileExists(id.vault, "raw/books/capital.md")).toBe(false);
    expect(await countTable(compileIntents)).toBe(0);
    const deletionRows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select()
          .from(sourceDeletionOutbox)
          .where(eq(sourceDeletionOutbox.sourceId, id.source)))
          .pipe(Effect.orDie);
      }),
    );
    expect(deletionRows).toHaveLength(1);
    expect(deletionRows[0]).toMatchObject({ attemptCount: 1 });
    expect(deletionRows[0]?.completedAt).toBeInstanceOf(Date);

    const missing = await api(
      "DELETE",
      `/vaults/${id.vault}/raw/sources/${id.source}`,
      freshAliceToken,
    );
    expect(missing.status).toBe(404);
  });

  it("commits source deletion and retries idempotent storage cleanup from its outbox", async () => {
    const { aliceToken } = currentFixture();
    await seedSourceGraph();
    const sourcePath = join(
      currentState().storageRoot,
      "vaults",
      id.vault,
      "raw/books/capital.md",
    );
    await rm(sourcePath);
    await mkdir(sourcePath);

    const deleted = await api(
      "DELETE",
      `/vaults/${id.vault}/raw/sources/${id.source}`,
      aliceToken,
    );
    expect(deleted.status).toBe(204);
    expect(await countTable(sourceDocuments)).toBe(0);
    expect(await countTable(ideas)).toBe(0);
    expect(await countTable(topicMembership)).toBe(0);
    expect(await countTable(searchIndex)).toBe(0);
    expect(await countTable(compileIntents)).toBe(0);

    const pending = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select()
          .from(sourceDeletionOutbox)
          .where(eq(sourceDeletionOutbox.sourceId, id.source)))
          .pipe(Effect.orDie);
      }),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ attemptCount: 1, completedAt: null });

    await rm(sourcePath, { recursive: true });
    const reconciled = await runDb(
      Effect.gen(function* () {
        const sourceDocumentsService = yield* SourceDocumentsService;
        return yield* sourceDocumentsService.reconcileDeletionsOnce();
      }),
    );
    expect(reconciled).toBe(1);

    const completed = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select()
          .from(sourceDeletionOutbox)
          .where(eq(sourceDeletionOutbox.sourceId, id.source)))
          .pipe(Effect.orDie);
      }),
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ attemptCount: 2 });
    expect(completed[0]?.completedAt).toBeInstanceOf(Date);
    expect(await vaultFileExists(id.vault, "raw/books/capital.md")).toBe(false);
  });

  it("ingests raw markdown with owner guards, frontmatter, hashes, and compile intents", async () => {
    const { aliceToken, bobToken } = currentFixture();
    const raw = await api("POST", `/vaults/${id.vault}/ingest`, aliceToken, {
      content: "# Raw Title\n\nRaw body paragraph.",
      dest: "raw/docs/raw-direct.md",
      origin: "fixture",
    });
    expect(raw.status).toBe(201);
    const rawResult = asRecord(raw.body);
    const rawId = String(rawResult.id);
    const rawPath = String(rawResult.file_path);
    expect(rawPath).toBe(`raw/docs/raw-direct-${rawId}.md`);
    const rawText = await readVaultFile(id.vault, rawPath);
    expect(rawText).toBe(
      `---\nsource_id: ${rawId}\nsource_type: document\norigin: fixture\n---\n# Raw Title\n\nRaw body paragraph. ^p0\n`,
    );

    const rawRows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select()
          .from(sourceDocuments)
          .where(
            and(
              eq(sourceDocuments.vaultId, id.vault),
              eq(sourceDocuments.id, rawId),
            ),
          ))
          .pipe(Effect.orDie);
      }),
    );
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0]).toMatchObject({
      id: rawId,
      filePath: rawPath,
      sourceType: "document",
      origin: "fixture",
      fileHash: fileContentHash(rawText),
      bodyHash: bodyContentHash("# Raw Title\n\nRaw body paragraph. ^p0\n"),
      clientHash: null,
    });
    const readById = await api(
      "GET",
      `/vaults/${id.vault}/raw/sources/${rawId}`,
      aliceToken,
    );
    expect(readById.status).toBe(200);
    expect(asRecord(asRecord(readById.body).article)).toMatchObject({
      id: rawId,
      file_path: rawPath,
    });
    expect(asRecord(readById.body).body).toBe(
      "# Raw Title\n\nRaw body paragraph. ^p0\n",
    );
    expect(await countTable(compileIntents)).toBe(1);

    const editorDenied = await api("POST", `/vaults/${id.vault}/ingest`, bobToken, {
      content: "Denied",
      dest: "raw/docs/denied.md",
    });
    expect(editorDenied.status).toBe(403);
  });

  it("stages local files through the shared durable ingest workflow", async () => {
    const { aliceToken, carolToken } = currentFixture();
    const encoder = new TextEncoder();
    const inputs = [
      {
        name: "report.md",
        type: "text/markdown",
        bytes: encoder.encode("# Alpha report\n\nAlpha upload body."),
      },
      {
        name: "report.txt",
        type: "text/plain",
        bytes: encoder.encode("# Beta report\n\nBeta upload body."),
      },
      {
        name: "html-upload.html",
        type: "text/html",
        bytes: encoder.encode(
          "<html><head><title>HTML Upload</title></head><body><main><h1>HTML Upload</h1><p>Converted upload paragraph.</p></main></body></html>",
        ),
      },
    ].map((input) => ({ ...input, hash: rawFileHash(input.bytes) }));
    const manifest = inputs.map((input) => ({
      name: input.name,
      size: input.bytes.byteLength,
      hash: input.hash,
      mimetype: input.type,
    }));

    const viewerPrepare = await api(
      "POST",
      `/vaults/${id.vault}/file-ingests`,
      carolToken,
      { batch_id: id.m32StagedRun, files: manifest },
    );
    expect(viewerPrepare.status).toBe(403);

    const duplicateManifest = await api(
      "POST",
      `/vaults/${id.vault}/file-ingests`,
      aliceToken,
      { batch_id: id.m32StagedRun, files: [manifest[0], manifest[0]] },
    );
    expect(duplicateManifest.status).toBe(400);
    expect(duplicateManifest.body).toMatchObject({
      detail: "duplicate file hashes are not allowed",
    });

    const prepared = await api(
      "POST",
      `/vaults/${id.vault}/file-ingests`,
      aliceToken,
      { batch_id: id.m32StagedRun, files: manifest },
    );
    expect(prepared.status).toBe(201);
    expect(asRecord(prepared.body)).toMatchObject({
      id: id.m32StagedRun,
      vault_id: id.vault,
      created_by: id.alice,
      status: "uploading",
    });
    expect(asArray(asRecord(prepared.body).targets)).toEqual(
      manifest.map((file) => ({ hash: file.hash, transport: "api" })),
    );

    const invalidHashForm = new FormData();
    invalidHashForm.append("file", new Blob(["invalid"]), "invalid.md");
    const invalidHash = await uploadApi(
      `/file-ingests/${id.m32StagedRun}/files/not-a-hash`,
      aliceToken,
      invalidHashForm,
    );
    expect(invalidHash.status).toBe(422);

    const mismatchForm = new FormData();
    mismatchForm.append("file", new Blob(["wrong bytes"]), inputs[0]!.name);
    const mismatch = await uploadApi(
      `/file-ingests/${id.m32StagedRun}/files/${inputs[0]!.hash}`,
      aliceToken,
      mismatchForm,
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toMatchObject({
      detail: "Uploaded file does not match its manifest",
    });

    for (const input of inputs) {
      const form = new FormData();
      form.append("file", new Blob([input.bytes], { type: input.type }), input.name);
      const uploaded = await uploadApi(
        `/file-ingests/${id.m32StagedRun}/files/${input.hash}`,
        aliceToken,
        form,
      );
      expect(uploaded.status).toBe(204);
      expect(
        await fileExists(
          join(
            currentState().storageRoot,
            "staging",
            id.vault,
            id.m32StagedRun,
            input.hash,
          ),
        ),
      ).toBe(true);
    }

    const processed = await api(
      "POST",
      `/file-ingests/${id.m32StagedRun}/commit`,
      aliceToken,
    );
    expect(processed.status).toBe(200);
    expect(asRecord(processed.body)).toMatchObject({
      id: id.m32StagedRun,
      vault_id: id.vault,
      trigger: "staged_files",
    });

    const completed = await waitFor(
      () =>
        runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            return (yield* db.query((d) => d
              .select()
              .from(pipelineRuns)
              .where(eq(pipelineRuns.id, id.m32StagedRun)))
              .pipe(Effect.orDie))[0];
          }),
        ),
      (run) => run?.phaseStatus === "completed" || run?.status === "failed",
    );
    expect(completed).toMatchObject({
      currentPhase: "source_ingest",
      phaseStatus: "completed",
      status: "running",
    });

    const sourceIds = inputs.map((input) =>
      sourceIdForKey(id.vault as Uuid, `upload:${input.hash}`),
    );
    expect(new Set(sourceIds).size).toBe(3);
    const sourcePaths = sourceIds.map((sourceId) => `raw/docs/${sourceId}.md`);
    expect(await readVaultFile(id.vault, sourcePaths[0]!)).toContain(
      "Alpha upload body. ^p0",
    );
    expect(await readVaultFile(id.vault, sourcePaths[1]!)).toContain(
      "Beta upload body. ^p0",
    );
    expect(await readVaultFile(id.vault, sourcePaths[2]!)).toContain(
      "# HTML Upload\n\nConverted upload paragraph. ^p0",
    );

    const rows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return {
          sources: yield* db.query((d) => d
            .select({ id: sourceDocuments.id, clientHash: sourceDocuments.clientHash })
            .from(sourceDocuments))
            .pipe(Effect.orDie),
          intents: yield* db.query((d) => d
            .select()
            .from(compileIntents))
            .pipe(Effect.orDie),
          batches: yield* db.query((d) => d
            .select()
            .from(fileIngestBatches)
            .where(eq(fileIngestBatches.id, id.m32StagedRun)))
            .pipe(Effect.orDie),
          batchFiles: yield* db.query((d) => d
            .select()
            .from(fileIngestFiles)
            .where(eq(fileIngestFiles.batchId, id.m32StagedRun)))
            .pipe(Effect.orDie),
        };
      }),
    );
    expect(new Set(rows.sources.map((row) => row.id))).toEqual(new Set(sourceIds));
    expect(new Set(rows.sources.map((row) => row.clientHash))).toEqual(
      new Set(inputs.map((input) => input.hash)),
    );
    expect(rows.intents).toHaveLength(1);
    expect(rows.intents[0]?.pipelineRunId).toBe(id.m32StagedRun);
    expect(rows.batches).toHaveLength(1);
    expect(rows.batches[0]).toMatchObject({
      id: id.m32StagedRun,
      createdBy: id.alice,
      status: "completed",
    });
    expect(rows.batchFiles).toHaveLength(inputs.length);
    expect(new Set(rows.batchFiles.map((file) => file.status))).toEqual(
      new Set(["completed"]),
    );

    for (const input of inputs) {
      expect(
        await fileExists(
          join(
            currentState().storageRoot,
            "staging",
            id.vault,
            id.m32StagedRun,
            input.hash,
          ),
        ),
      ).toBe(false);
    }

    const dupes = await api(
      "POST",
      `/vaults/${id.vault}/file-ingests/check-dupes`,
      aliceToken,
      { client_hashes: inputs.map((input) => input.hash) },
    );
    expect(dupes.status).toBe(200);
    expect(new Set(asRecord(dupes.body).existing as string[])).toEqual(
      new Set(inputs.map((input) => input.hash)),
    );
  });

  it("resumes durable receipts and isolates concurrent batch cleanup", async () => {
    const { aliceToken } = currentFixture();
    const bytes = new TextEncoder().encode("# Shared bytes\n\nEach batch owns its staging object.");
    const hash = rawFileHash(bytes);
    const manifest = [
      {
        name: "shared.md",
        size: bytes.byteLength,
        hash,
        mimetype: "text/markdown",
      },
    ];

    for (const batchId of [id.m32StagedRun, id.m32StagedRunOther]) {
      const created = await api(
        "POST",
        `/vaults/${id.vault}/file-ingests`,
        aliceToken,
        { batch_id: batchId, files: manifest },
      );
      expect(created.status).toBe(201);
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "text/markdown" }), "shared.md");
      const uploaded = await uploadApi(
        `/file-ingests/${batchId}/files/${hash}`,
        aliceToken,
        form,
      );
      expect(uploaded.status).toBe(204);
    }

    const resumed = await api(
      "POST",
      `/file-ingests/${id.m32StagedRun}/resume`,
      aliceToken,
    );
    expect(resumed.status).toBe(200);
    expect(asArray(asRecord(resumed.body).files)[0]).toMatchObject({
      name: "shared.md",
      status: "uploaded",
    });
    expect(asRecord(resumed.body).targets).toEqual([]);

    const cancelled = await api(
      "POST",
      `/vaults/${id.vault}/compile/${id.m32StagedRun}/cancel`,
      aliceToken,
    );
    expect(cancelled.status).toBe(204);
    expect(
      await fileExists(
        join(
          currentState().storageRoot,
          "staging",
          id.vault,
          id.m32StagedRun,
          hash,
        ),
      ),
    ).toBe(false);
    expect(
      await fileExists(
        join(
          currentState().storageRoot,
          "staging",
          id.vault,
          id.m32StagedRunOther,
          hash,
        ),
      ),
    ).toBe(true);

    const cancelledBatch = await api(
      "GET",
      `/file-ingests/${id.m32StagedRun}`,
      aliceToken,
    );
    expect(asRecord(cancelledBatch.body).status).toBe("cancelled");

    const committed = await api(
      "POST",
      `/file-ingests/${id.m32StagedRunOther}/commit`,
      aliceToken,
    );
    expect(committed.status).toBe(200);
    const completed = await waitFor(
      () =>
        runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            return (yield* db.query((d) => d
              .select()
              .from(fileIngestBatches)
              .where(eq(fileIngestBatches.id, id.m32StagedRunOther)))
              .pipe(Effect.orDie))[0];
          }),
        ),
      (batch) => batch?.status === "completed" || batch?.status === "failed",
    );
    expect(completed?.status).toBe("completed");
  });

  it("branches all user suggestion intents between owner direct ingest and editor proposals", async () => {
    const { aliceToken, bobToken, carolToken } = currentFixture();
    const intents = ["disagree", "correct", "add_context", "restructure"] as const;

    for (const [index, intent] of intents.entries()) {
      currentState().clock.set(new Date(initialTime.getTime() + index * 1000));
      const owner = await api("POST", `/vaults/${id.vault}/ingest/user-suggestion`, aliceToken, {
        body: `Owner ${intent} suggestion.`,
        intent,
        anchored_to: `Owner Anchor ${intent}`,
        anchored_section: "section-one",
      });
      expect(owner.status).toBe(201);
      expect(asRecord(owner.body).mode).toBe("ingested");
      const ownerPath = String(asRecord(owner.body).file_path);
      const ownerText = await readVaultFile(id.vault, ownerPath);
      expect(ownerText).toContain("source_type: user");
      expect(ownerText).toContain("origin: user-suggestion");
      expect(ownerText).toContain(`intent: ${intent}`);
      expect(ownerText).toContain(`anchored_to: Owner Anchor ${intent}`);

      currentState().clock.set(new Date(initialTime.getTime() + (index + 10) * 1000));
      const editor = await api("POST", `/vaults/${id.vault}/ingest/user-suggestion`, bobToken, {
        body: `Editor ${intent} suggestion.`,
        intent,
        anchored_to: `Editor Anchor ${intent}`,
        anchored_section: "section-two",
      });
      expect(editor.status).toBe(201);
      const editorResult = asRecord(editor.body);
      expect(editorResult.mode).toBe("proposed");
      const editorId = String(editorResult.id);
      const editorPath = String(editorResult.file_path);
      const proposalRows = await runDb(
        Effect.gen(function* () {
          const db = yield* Database;
          return yield* db.query((d) => d
            .select()
            .from(sourceProposals)
            .where(
              and(eq(sourceProposals.vaultId, id.vault), eq(sourceProposals.destPath, editorPath)),
            ))
            .pipe(Effect.orDie);
        }),
      );
      expect(proposalRows).toHaveLength(1);
      expect(proposalRows[0]).toMatchObject({
        status: "PENDING",
        contentType: "user_suggestion",
        sourceId: editorId,
      });
      const staged = await readFile(
        join(currentState().storageRoot, "proposals", `${proposalRows[0]!.id}.md`),
        "utf8",
      );
      expect(staged).toContain(`intent: ${intent}`);
      expect(staged).toContain(`anchored_to: Editor Anchor ${intent}`);
    }

    expect(await countTable(sourceDocuments)).toBe(4);
    expect(await countTable(sourceProposals)).toBe(4);
    expect(await countTable(compileIntents)).toBe(1);

    const blank = await api("POST", `/vaults/${id.vault}/ingest/user-suggestion`, aliceToken, {
      body: "   ",
      intent: "correct",
    });
    expect(blank.status).toBe(400);
    expect(blank.body).toMatchObject({ detail: "body is empty" });

    const viewer = await api("POST", `/vaults/${id.vault}/ingest/user-suggestion`, carolToken, {
      body: "Viewer suggestion",
      intent: "correct",
    });
    expect(viewer.status).toBe(403);
  });

  it("persists immutable file-ingest manifests before upload", async () => {
    const { aliceToken, bobToken } = currentFixture();
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(sourceDocuments)
          .values([
            {
              id: id.m32SourceA,
              vaultId: id.vault,
              filePath: "raw/docs/a.md",
              fileHash: "file-a",
              bodyHash: "body-a",
              clientHash: hashA,
              sourceType: "document",
              tags: [],
              derivedExtras: {},
            },
            {
              id: id.m32SourceB,
              vaultId: id.vault,
              filePath: "raw/docs/b.md",
              fileHash: "file-b",
              bodyHash: "body-b",
              clientHash: hashA,
              sourceType: "document",
              tags: [],
              derivedExtras: {},
            },
          ]))
          .pipe(Effect.orDie);
      }),
    );

    const dupes = await api(
      "POST",
      `/vaults/${id.vault}/file-ingests/check-dupes`,
      aliceToken,
      { client_hashes: [hashA, hashB] },
    );
    expect(dupes.status).toBe(200);
    expect(asRecord(dupes.body).existing).toEqual([hashA, hashA]);

    const editorDupes = await api(
      "POST",
      `/vaults/${id.vault}/file-ingests/check-dupes`,
      bobToken,
      { client_hashes: [hashA] },
    );
    expect(editorDupes.status).toBe(403);

    const knownDuplicate = await api(
      "POST",
      `/vaults/${id.vault}/file-ingests`,
      aliceToken,
      {
        batch_id: id.m32StagedRunOther,
        files: [{ name: "known.md", size: 10, hash: hashA, mimetype: "text/markdown" }],
      },
    );
    expect(knownDuplicate.status).toBe(201);
    const knownFile = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return (yield* db.query((d) => d
          .select()
          .from(fileIngestFiles)
          .where(eq(fileIngestFiles.batchId, id.m32StagedRunOther)))
          .pipe(Effect.orDie))[0];
      }),
    );
    expect(knownFile?.needsCompile).toBe(false);
    await api(
      "POST",
      `/vaults/${id.vault}/compile/${id.m32StagedRunOther}/cancel`,
      aliceToken,
    );

    const emptyCreate = await api(
      "POST",
      `/vaults/${id.vault}/file-ingests`,
      aliceToken,
      { batch_id: id.m32StagedRun, files: [] },
    );
    expect(emptyCreate.status).toBe(400);
    expect(emptyCreate.body).toMatchObject({ detail: "no files provided" });

    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d.delete(sourceDocuments)).pipe(Effect.orDie);
      }),
    );
    const manifest = [
      { name: "a.md", size: 10, hash: hashA, mimetype: "text/markdown" },
    ];
    const created = await api(
      "POST",
      `/vaults/${id.vault}/file-ingests`,
      aliceToken,
      { batch_id: id.m32StagedRun, files: manifest },
    );
    expect(created.status).toBe(201);
    expect(asRecord(created.body)).toMatchObject({
      id: id.m32StagedRun,
      vault_id: id.vault,
      created_by: id.alice,
      status: "uploading",
    });

    const replayed = await api(
      "POST",
      `/vaults/${id.vault}/file-ingests`,
      aliceToken,
      { batch_id: id.m32StagedRun, files: manifest },
    );
    expect(replayed.status).toBe(201);
    expect(asRecord(replayed.body).id).toBe(id.m32StagedRun);

    const conflicting = await api(
      "POST",
      `/vaults/${id.vault}/file-ingests`,
      aliceToken,
      {
        batch_id: id.m32StagedRun,
        files: [{ ...manifest[0], name: "different.md" }],
      },
    );
    expect(conflicting.status).toBe(409);
    expect(conflicting.body).toMatchObject({
      detail: "Batch ID is bound to a different manifest",
    });

    const visibleToMember = await api(
      "GET",
      `/file-ingests/${id.m32StagedRun}`,
      bobToken,
    );
    expect(visibleToMember.status).toBe(200);
    expect(asRecord(visibleToMember.body).targets).toEqual([]);
    const editorResume = await api(
      "POST",
      `/file-ingests/${id.m32StagedRun}/resume`,
      bobToken,
    );
    expect(editorResume.status).toBe(403);

    const prematureCommit = await api(
      "POST",
      `/file-ingests/${id.m32StagedRun}/commit`,
      aliceToken,
    );
    expect(prematureCommit.status).toBe(400);
    expect(prematureCommit.body).toMatchObject({ detail: "Waiting for uploads: a.md" });

    const rows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return {
          appTasks: yield* db.query((d) => d
            .select()
            .from(tasks)
            .where(eq(tasks.pipelineRunId, id.m32StagedRun)))
            .pipe(Effect.orDie),
          runs: yield* db.query((d) => d
            .select()
            .from(pipelineRuns)
            .where(eq(pipelineRuns.id, id.m32StagedRun)))
            .pipe(Effect.orDie),
          batches: yield* db.query((d) => d
            .select()
            .from(fileIngestBatches)
            .where(eq(fileIngestBatches.id, id.m32StagedRun)))
            .pipe(Effect.orDie),
          files: yield* db.query((d) => d
            .select()
            .from(fileIngestFiles)
            .where(eq(fileIngestFiles.batchId, id.m32StagedRun)))
            .pipe(Effect.orDie),
        };
      }),
    );
    expect(rows.appTasks).toHaveLength(0);
    expect(rows.runs[0]).toMatchObject({
      status: "running",
      currentPhase: "source_ingest",
      activeTaskId: null,
    });
    expect(rows.batches[0]).toMatchObject({
      createdBy: id.alice,
      status: "uploading",
    });
    expect(rows.files).toHaveLength(1);
    expect(rows.files[0]).toMatchObject({
      status: "pending",
      position: 0,
      needsCompile: true,
    });
    expect(await countTable(compileIntents)).toBe(0);
  });

  it("expires abandoned durable file-ingest batches", async () => {
    const { aliceToken } = currentFixture();
    const hash = "c".repeat(64);
    const created = await api(
      "POST",
      `/vaults/${id.vault}/file-ingests`,
      aliceToken,
      {
        batch_id: id.m32StagedRun,
        files: [
          {
            name: "abandoned.md",
            size: 12,
            hash,
            mimetype: "text/markdown",
          },
        ],
      },
    );
    expect(created.status).toBe(201);

    currentState().clock.set(new Date(initialTime.getTime() + 25 * 60 * 60 * 1000));
    const reconciled = await runDb(
      Effect.gen(function* () {
        const batches = yield* FileIngestBatches;
        return yield* batches.reconcileOnce();
      }),
    );
    expect(reconciled.expired).toBe(1);

    const state = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return {
          batch: (yield* db.query((d) => d
            .select()
            .from(fileIngestBatches)
            .where(eq(fileIngestBatches.id, id.m32StagedRun)))
            .pipe(Effect.orDie))[0],
          file: (yield* db.query((d) => d
            .select()
            .from(fileIngestFiles)
            .where(eq(fileIngestFiles.batchId, id.m32StagedRun)))
            .pipe(Effect.orDie))[0],
          run: (yield* db.query((d) => d
            .select()
            .from(pipelineRuns)
            .where(eq(pipelineRuns.id, id.m32StagedRun)))
            .pipe(Effect.orDie))[0],
        };
      }),
    );
    expect(state.batch).toMatchObject({
      status: "failed",
      error: "Upload expired before all files arrived",
    });
    expect(state.file).toMatchObject({ status: "failed" });
    expect(state.run).toMatchObject({ status: "failed", phaseStatus: "failed" });
  });

  it("creates, lists, reads, and deletes owner-scoped personal references", async () => {
    const { aliceToken, bobToken } = currentFixture();
    let articleRequests = 0;
    await withLocalHttpServer(
      (request, response) => {
        if (request.url === "/article") {
          articleRequests += 1;
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(
            "<html><head><title>Personal Article</title><meta name=\"author\" content=\"Ada Lovelace\"><meta property=\"article:published_time\" content=\"2024-03-01\"></head><body><article><p>First personal paragraph with enough detail for article extraction.</p><p>Second personal paragraph stays outside every vault corpus.</p><p>Third personal paragraph supports a BTW question.</p></article></body></html>",
          );
          return;
        }
        if (request.url === "/missing") {
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("Missing file body.");
          return;
        }
        if (request.url === "/one/story" || request.url === "/two/story") {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(
            `<html><head><title>Story ${request.url}</title></head><body><article><p>Distinct story body for ${request.url} with enough words to extract.</p><p>Second paragraph keeps readability satisfied.</p></article></body></html>`,
          );
          return;
        }
        response.writeHead(200, { "content-type": "application/pdf" });
        response.end(Buffer.from("%PDF-1.7\nnot supported\n"));
      },
      async (origin) => {
        const created = await api("POST", "/me/refs", aliceToken, {
          url: `${origin}/article`,
        });
        expect(created.status).toBe(201);
        const createdBody = asRecord(created.body);
        expect(createdBody).toMatchObject({
          file_path: "refs/article.md",
          title: "Personal Article",
          url: `${origin}/article`,
          origin: new URL(origin).host,
          author: "Ada Lovelace",
          published: "2024-03-01",
        });

        const content = await readUserFile(id.alice, "refs/article.md");
        expect(content).toContain("source_type: document");
        expect(content).toContain(`url: ${origin}/article`);
        expect(content).toContain("First personal paragraph");
        expect(content).toContain("^p0");
        expect(content).not.toContain("# Personal Article");

        const storedRows = await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            return yield* db.query((d) => d
              .select()
              .from(userDocuments)
              .where(eq(userDocuments.userId, id.alice)))
              .pipe(Effect.orDie);
          }),
        );
        expect(storedRows).toHaveLength(1);
        expect(storedRows[0]).toMatchObject({
          filePath: "refs/article.md",
          fileHash: fileContentHash(content),
          bodyHash: bodyContentHash(parseFrontmatter(content).body),
          title: "Personal Article",
          author: "Ada Lovelace",
          published: "2024-03-01",
        });
        expect(await countTable(sourceDocuments)).toBe(0);
        expect(await countTable(searchIndex)).toBe(0);
        expect(await countTable(compileIntents)).toBe(0);

        const duplicate = await api("POST", "/me/refs", aliceToken, {
          url: `${origin}/article`,
        });
        expect(duplicate.status).toBe(200);
        expect(asRecord(duplicate.body).id).toBe(createdBody.id);
        expect(articleRequests).toBe(1);

        const listed = await api("GET", "/me/refs?limit=10&offset=0", aliceToken);
        expect(listed.status).toBe(200);
        expect(asRecord(listed.body)).toMatchObject({
          items: [createdBody],
          pagination: { limit: 10, offset: 0, total: 1 },
        });

        const read = await api("GET", "/me/refs/doc?path=refs/article.md", aliceToken);
        expect(read.status).toBe(200);
        expect(asRecord(read.body)).toMatchObject({
          reference: createdBody,
        });
        expect(String(asRecord(read.body).body)).toContain("First personal paragraph");

        const otherUser = await api("GET", "/me/refs/doc?path=refs/article.md", bobToken);
        expect(otherUser.status).toBe(404);
        const traversal = await api("GET", "/me/refs/doc?path=refs%5Cescape.md", aliceToken);
        expect(traversal.status).toBe(400);

        const unsupported = await api("POST", "/me/refs", aliceToken, {
          url: `${origin}/unsupported`,
        });
        expect(unsupported.status).toBe(400);
        expect(String(asRecord(unsupported.body).detail)).toContain(
          "Unsupported URL content-type: application/pdf",
        );

        const missingCreated = await api("POST", "/me/refs", aliceToken, {
          url: `${origin}/missing`,
        });
        expect(missingCreated.status).toBe(201);
        await rm(
          join(currentState().storageRoot, "users", id.alice, "refs", "missing.md"),
        );
        const missingFile = await api("GET", "/me/refs/doc?path=refs/missing.md", aliceToken);
        expect(missingFile.status).toBe(404);

        const storyOne = await api("POST", "/me/refs", aliceToken, {
          url: `${origin}/one/story`,
        });
        expect(storyOne.status).toBe(201);
        expect(asRecord(storyOne.body).file_path).toBe("refs/story.md");
        const storyTwo = await api("POST", "/me/refs", aliceToken, {
          url: `${origin}/two/story`,
        });
        expect(storyTwo.status).toBe(201);
        const storyTwoPath = String(asRecord(storyTwo.body).file_path);
        expect(storyTwoPath).toMatch(/^refs\/story-[0-9a-f]{8}\.md$/);
        const storyOneRead = await api("GET", "/me/refs/doc?path=refs/story.md", aliceToken);
        expect(storyOneRead.status).toBe(200);
        expect(asRecord(asRecord(storyOneRead.body).reference).url).toBe(`${origin}/one/story`);
        const storyTwoRead = await api("GET", `/me/refs/doc?path=${storyTwoPath}`, aliceToken);
        expect(storyTwoRead.status).toBe(200);
        expect(asRecord(asRecord(storyTwoRead.body).reference).url).toBe(`${origin}/two/story`);

        const deleted = await api("DELETE", `/me/refs/${createdBody.id}`, aliceToken);
        expect(deleted.status).toBe(204);
        expect(await userFileExists(id.alice, "refs/article.md")).toBe(false);
        const deletedAgain = await api("DELETE", `/me/refs/${createdBody.id}`, aliceToken);
        expect(deletedAgain.status).toBe(404);
      },
    );
  });

  it("renames personal references, trims titles, and clears them to null", async () => {
    const { aliceToken, bobToken } = currentFixture();
    await withLocalHttpServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<html><head><title>Renamable Article</title></head><body><article><p>Renamable first paragraph with enough detail for article extraction.</p><p>Renamable second paragraph stays outside every vault corpus.</p></article></body></html>",
        );
      },
      async (origin) => {
        const created = await api("POST", "/me/refs", aliceToken, {
          url: `${origin}/article`,
        });
        expect(created.status).toBe(201);
        expect(asRecord(created.body).title).toBe("Renamable Article");
        const contentBefore = await readUserFile(id.alice, "refs/article.md");

        const renamed = await api(
          "PATCH",
          `/me/refs/${asRecord(created.body).id}`,
          aliceToken,
          { title: "  Cleaned Up Title  " },
        );
        expect(renamed.status).toBe(200);
        expect(asRecord(renamed.body)).toMatchObject({
          file_path: "refs/article.md",
          title: "Cleaned Up Title",
        });

        // The stored markdown is untouched; only the user_documents row moves.
        expect(await readUserFile(id.alice, "refs/article.md")).toBe(contentBefore);
        const storedRows = await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            return yield* db.query((d) => d
              .select()
              .from(userDocuments)
              .where(eq(userDocuments.userId, id.alice)))
              .pipe(Effect.orDie);
          }),
        );
        expect(storedRows).toHaveLength(1);
        expect(storedRows[0]).toMatchObject({
          filePath: "refs/article.md",
          title: "Cleaned Up Title",
        });

        const cleared = await api(
          "PATCH",
          `/me/refs/${asRecord(created.body).id}`,
          aliceToken,
          { title: "   " },
        );
        expect(cleared.status).toBe(200);
        expect(asRecord(cleared.body).title).toBeNull();

        const explicitNull = await api(
          "PATCH",
          `/me/refs/${asRecord(created.body).id}`,
          aliceToken,
          { title: null },
        );
        expect(explicitNull.status).toBe(200);
        expect(asRecord(explicitNull.body).title).toBeNull();

        const otherUser = await api(
          "PATCH",
          `/me/refs/${asRecord(created.body).id}`,
          bobToken,
          { title: "Sneaky" },
        );
        expect(otherUser.status).toBe(404);

        const traversal = await api(
          "PATCH",
          "/me/refs/not-a-reference-id",
          aliceToken,
          { title: "X" },
        );
        expect(traversal.status).toBe( 422);

        const missing = await api(
          "PATCH",
          "/me/refs/018f6a2e-0000-7000-8000-00000000dead",
          aliceToken,
          { title: "X" },
        );
        expect(missing.status).toBe(404);
      },
    );
  });

  it("reflects reference renames in session origin titles", async () => {
    const { aliceToken } = currentFixture();
    await withLocalHttpServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<html><head><title>Origin Title Article</title></head><body><article><p>Origin title first paragraph with enough detail for article extraction.</p><p>Origin title second paragraph stays outside every vault corpus.</p></article></body></html>",
        );
      },
      async (origin) => {
        const created = await api("POST", "/me/refs", aliceToken, {
          url: `${origin}/article`,
        });
        expect(created.status).toBe(201);
        expect(asRecord(created.body).title).toBe("Origin Title Article");

        await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            yield* db.query((d) => d
              .insert(sessions)
              .values({
                id: "s-rename-origin",
                vaultId: id.vault,
                userId: id.alice,
                query: "Anchored session on the reference",
                origin: {
                  doc_path: "refs/article.md",
                  origin_scope: "personal",
                  anchor: "Origin title first paragraph with enough detail for article extraction.",
                  paragraph: "Origin title first paragraph with enough detail for article extraction.",
                  paragraph_index: 0,
                },
                createdAt: new Date("2026-07-11T09:00:00.000Z"),
                updatedAt: new Date("2026-07-11T09:05:00.000Z"),
              }))
              .pipe(Effect.orDie);
          }),
        );
        await writeVaultFile(
          id.vault,
          "sessions/s-rename-origin.jsonl",
          jsonl([
            {
              type: "meta",
              id: "s-rename-origin",
              query: "Anchored session on the reference",
              ts: "2026-07-11T09:00:00.000Z",
              user_id: id.alice,
              origin: {
                doc_path: "refs/article.md",
                origin_scope: "personal",
                anchor: "Origin title first paragraph with enough detail for article extraction.",
                paragraph: "Origin title first paragraph with enough detail for article extraction.",
                paragraph_index: 0,
              },
            },
            {
              type: "exchange",
              exId: "ex-rename-origin",
              query: "Anchored session on the reference",
              thinking: [],
              answer: "Anchored answer.",
              ts: "2026-07-11T09:05:00.000Z",
            },
          ]),
        );

        const before = await api(
          "GET",
          `/vaults/${id.vault}/sessions/by-origin?doc_path=${encodeURIComponent("refs/article.md")}`,
          aliceToken,
        );
        expect(before.status).toBe(200);
        expect(asRecord(asRecord(asArray(before.body)[0]).session)).toMatchObject({
          id: "s-rename-origin",
          origin_title: "Origin Title Article",
        });

        const renamed = await api(
          "PATCH",
          `/me/refs/${asRecord(created.body).id}`,
          aliceToken,
          { title: "Renamed Origin Article" },
        );
        expect(renamed.status).toBe(200);

        const after = await api(
          "GET",
          `/vaults/${id.vault}/sessions/by-origin?doc_path=${encodeURIComponent("refs/article.md")}`,
          aliceToken,
        );
        expect(after.status).toBe(200);
        expect(asRecord(asRecord(asArray(after.body)[0]).session)).toMatchObject({
          id: "s-rename-origin",
          origin_title: "Renamed Origin Article",
        });
      },
    );
  });

  it("promotes personal references as idempotent owner-scoped copies", async () => {
    const { aliceToken, malloryToken } = currentFixture();
    await withLocalHttpServer(
      (request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<html><head><title>Promoted Reference</title></head><body><article><p>Promoted body for ${request.url} remains byte-identical to the personal reference.</p><p>A second paragraph carries another stable block anchor.</p></article></body></html>`,
        );
      },
      async (origin) => {
        const created = await api("POST", "/me/refs", aliceToken, {
          url: `${origin}/promoted`,
        });
        expect(created.status).toBe(201);
        const createdReference = asRecord(created.body);
        const referenceId = String(createdReference.id);
        const referencePath = String(createdReference.file_path);
        const personalBefore = await readUserFile(id.alice, referencePath);
        const sourceId = sourceIdForKey(id.vault as Uuid, `reference:${referenceId}`);
        const sourcePath = `raw/docs/promoted-${sourceId}.md`;

        const promoted = await api(
          "POST",
          `/vaults/${id.vault}/ingest/reference`,
          aliceToken,
          { path: referencePath },
        );
        expect(promoted.status).toBe(201);
        expect(promoted.body).toEqual({ id: sourceId, file_path: sourcePath });
        const promotedText = await readVaultFile(id.vault, sourcePath);
        expect(parseFrontmatter(promotedText).body).toBe(parseFrontmatter(personalBefore).body);

        const rows = await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            return yield* db.query((d) => d
              .select()
              .from(sourceDocuments)
              .where(
                and(
                  eq(sourceDocuments.vaultId, id.vault),
                  eq(sourceDocuments.id, sourceId),
                ),
              ))
              .pipe(Effect.orDie);
          }),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          bodyHash: bodyContentHash(parseFrontmatter(personalBefore).body),
          url: `${origin}/promoted`,
          origin: new URL(origin).host,
        });
        expect(await countTable(compileIntents)).toBe(1);
        expect(await countTable(userDocuments)).toBe(1);
        expect(await readUserFile(id.alice, referencePath)).toBe(personalBefore);

        const repeated = await api(
          "POST",
          `/vaults/${id.vault}/ingest/reference`,
          aliceToken,
          { path: referencePath },
        );
        expect(repeated.status).toBe(200);
        expect(repeated.body).toEqual(promoted.body);
        expect(await countTable(sourceDocuments)).toBe(1);
        expect(await countTable(compileIntents)).toBe(1);

        const outsider = await api("POST", "/me/refs", malloryToken, {
          url: `${origin}/outsider`,
        });
        expect(outsider.status).toBe(201);
        const forbidden = await api(
          "POST",
          `/vaults/${id.vault}/ingest/reference`,
          malloryToken,
          { path: String(asRecord(outsider.body).file_path) },
        );
        expect(forbidden.status).toBe(403);

        const missing = await api(
          "POST",
          `/vaults/${id.vault}/ingest/reference`,
          aliceToken,
          { path: "refs/unknown.md" },
        );
        expect(missing.status).toBe(404);
      },
    );
  });

  it("accepts durable jobs/url with owner guard, stable identity, retry, and terminal failures", async () => {
    const { aliceToken, carolToken, malloryToken } = currentFixture();
    let releaseSlowResponse: (() => void) | undefined;
    let markSlowRequestStarted: (() => void) | undefined;
    const slowRequestStarted = new Promise<void>((resolve) => {
      markSlowRequestStarted = resolve;
    });
    await withLocalHttpServer(
      (request, response) => {
        if (request.url === "/slow") {
          response.writeHead(200, { "content-type": "text/plain" });
          releaseSlowResponse = () => response.end("Durably accepted slow URL body.");
          markSlowRequestStarted?.();
          return;
        }
        if (request.url === "/ok") {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            "<html><head><title>Local Article</title></head><body><main><h1>Local Article</h1><p>Converted paragraph.</p></main></body></html>",
          );
          return;
        }
        if (request.url === "/one/report") {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            "<html><head><title>Report Alpha</title></head><body><main><p>Alpha report body remains its own source.</p></main></body></html>",
          );
          return;
        }
        if (request.url === "/two/report?version=2") {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            "<html><head><title>Report Beta</title></head><body><main><p>Beta report body must coexist with alpha.</p></main></body></html>",
          );
          return;
        }
        if (request.url === "/reconcile") {
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("Recovered URL operation body.");
          return;
        }
        if (request.url === "/pdf") {
          response.writeHead(200, { "content-type": "application/pdf" });
          response.end(Buffer.from("%PDF-1.7\nnot indexed\n"));
          return;
        }
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("failed");
      },
      async (origin) => {
        const slowUrl = `${origin}/slow`;
        const acceptedSlow = await api("POST", `/vaults/${id.vault}/jobs/url`, aliceToken, {
          job_id: id.m32UrlSlowRun,
          url: slowUrl,
        });
        expect(acceptedSlow.status).toBe(201);
        expect(asRecord(acceptedSlow.body)).toMatchObject({
          id: id.m32UrlSlowRun,
          status: "pending",
          phase_status: "started",
        });
        await slowRequestStarted;
        const acceptedRows = await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            return yield* db.query((d) => d
              .select()
              .from(urlIngestRequests)
              .where(eq(urlIngestRequests.id, id.m32UrlSlowRun)))
              .pipe(Effect.orDie);
          }),
        );
        expect(acceptedRows[0]).toMatchObject({
          id: id.m32UrlSlowRun,
          createdBy: id.alice,
          canonicalUrl: slowUrl,
          dispatchedTaskId: id.m32UrlSlowRun,
        });
        if (releaseSlowResponse === undefined) {
          throw new Error("slow URL request was not held");
        }
        releaseSlowResponse();
        await waitForPipelineRun(id.m32UrlSlowRun, (row) => row.phaseStatus === "completed");
        await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            yield* db.query((d) => d
              .update(compileIntents)
              .set({ dispatchedAt: sql`now()`, satisfiedAt: sql`now()` })
              .where(eq(compileIntents.pipelineRunId, id.m32UrlSlowRun)))
              .pipe(Effect.orDie);
          }),
        );

        const ownerSuccess = await api("POST", `/vaults/${id.vault}/jobs/url`, aliceToken, {
          job_id: id.m32UrlRun,
          url: `${origin}/ok#ignored-fragment`,
        });
        expect(ownerSuccess.status).toBe(201);
        expect(asRecord(ownerSuccess.body)).toMatchObject({
          id: id.m32UrlRun,
          trigger: "url",
          status: "pending",
          current_phase: "source_ingest",
          phase_status: "started",
          stream_url: `/jobs/${id.m32UrlRun}/stream`,
        });
        await waitForPipelineRun(
          id.m32UrlRun,
          (row) => row.currentPhase === "source_ingest" && row.phaseStatus === "completed",
        );

        const canonicalUrl = `${origin}/ok`;
        const sourceId = sourceIdForKey(id.vault as Uuid, `url:${canonicalUrl}`);
        const sourcePath = `raw/docs/ok-${sourceId}.md`;
        const markdown = await readVaultFile(id.vault, sourcePath);
        expect(markdown).toBe(
          `---\nsource_id: ${sourceId}\ncanonical_url: ${canonicalUrl}\nsource_type: document\nurl: ${canonicalUrl}\norigin: ${new URL(origin).host}\n---\n# Local Article\n\nConverted paragraph. ^p0\n`,
        );

        const successRows = await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            const sourceRows = yield* db.query((d) => d
              .select()
              .from(sourceDocuments)
              .where(eq(sourceDocuments.id, sourceId)))
              .pipe(Effect.orDie);
            const intentRows = yield* db.query((d) => d
              .select()
              .from(compileIntents)
              .where(eq(compileIntents.pipelineRunId, id.m32UrlRun)))
              .pipe(Effect.orDie);
            const runRows = yield* db.query((d) => d
              .select()
              .from(pipelineRuns)
              .where(eq(pipelineRuns.id, id.m32UrlRun)))
              .pipe(Effect.orDie);
            const requestRows = yield* db.query((d) => d
              .select()
              .from(urlIngestRequests)
              .where(eq(urlIngestRequests.id, id.m32UrlRun)))
              .pipe(Effect.orDie);
            return { sourceRows, intentRows, runRows, requestRows };
          }),
        );
        expect(successRows.sourceRows).toHaveLength(1);
        expect(successRows.sourceRows[0]).toMatchObject({
          id: sourceId,
          filePath: sourcePath,
          sourceType: "document",
          url: canonicalUrl,
          canonicalUrl,
        });
        expect(successRows.intentRows).toHaveLength(1);
        expect(successRows.runRows[0]?.compileIntentId).toBe(successRows.intentRows[0]?.id);
        expect(successRows.requestRows[0]).toMatchObject({
          id: id.m32UrlRun,
          createdBy: id.alice,
          canonicalUrl,
          dispatchedTaskId: id.m32UrlRun,
        });
        expect(successRows.requestRows[0]?.dispatchedAt).not.toBeNull();

        const viewerDenied = await api("POST", `/vaults/${id.vault}/jobs/url`, carolToken, {
          job_id: "00000000-0000-4000-8000-000000013198",
          url: canonicalUrl,
        });
        expect(viewerDenied.status).toBe(403);

        const alphaUrl = `${origin}/one/report`;
        const betaUrl = `${origin}/two/report?version=2`;
        const alphaId = sourceIdForKey(id.vault as Uuid, `url:${alphaUrl}`);
        const betaId = sourceIdForKey(id.vault as Uuid, `url:${betaUrl}`);
        const alphaPath = `raw/docs/report-${alphaId}.md`;
        const betaPath = `raw/docs/report-${betaId}.md`;
        const alpha = await api("POST", `/vaults/${id.vault}/jobs/url`, aliceToken, {
          job_id: id.m32UrlCollisionA,
          url: alphaUrl,
        });
        const beta = await api("POST", `/vaults/${id.vault}/jobs/url`, aliceToken, {
          job_id: id.m32UrlCollisionB,
          url: betaUrl,
        });
        expect([alpha.status, beta.status]).toEqual([201, 201]);
        await Promise.all([
          waitForPipelineRun(id.m32UrlCollisionA, (row) => row.phaseStatus === "completed"),
          waitForPipelineRun(id.m32UrlCollisionB, (row) => row.phaseStatus === "completed"),
        ]);
        expect(await readVaultFile(id.vault, alphaPath)).toContain(
          "Alpha report body remains its own source.",
        );
        expect(await readVaultFile(id.vault, betaPath)).toContain(
          "Beta report body must coexist with alpha.",
        );

        const replay = await api("POST", `/vaults/${id.vault}/jobs/url`, aliceToken, {
          job_id: id.m32UrlReplayRun,
          url: alphaUrl,
        });
        expect(replay.status).toBe(201);
        await waitForPipelineRun(id.m32UrlReplayRun, (row) => row.phaseStatus === "completed");
        const collisionRows = await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            return yield* db.query((d) => d
              .select()
              .from(sourceDocuments)
              .where(eq(sourceDocuments.vaultId, id.vault)))
              .pipe(Effect.orDie);
          }),
        );
        expect(collisionRows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: alphaId, filePath: alphaPath, canonicalUrl: alphaUrl }),
            expect.objectContaining({ id: betaId, filePath: betaPath, canonicalUrl: betaUrl }),
          ]),
        );
        expect(collisionRows.filter((row) => row.id === alphaId)).toHaveLength(1);

        const failed = await api("POST", `/vaults/${id.vault}/jobs/url`, aliceToken, {
          job_id: id.m32UrlFailRun,
          url: `${origin}/fail`,
        });
        expect(failed.status).toBe(201);
        await waitForPipelineRun(id.m32UrlFailRun, (row) => row.status === "failed");
        const failedRuns = await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            return yield* db.query((d) => d
              .select()
              .from(pipelineRuns)
              .where(eq(pipelineRuns.id, id.m32UrlFailRun)))
              .pipe(Effect.orDie);
          }),
        );
        expect(failedRuns).toHaveLength(1);
        expect(failedRuns[0]).toMatchObject({
          status: "failed",
          currentPhase: "source_ingest",
          phaseStatus: "failed",
        });
        expect(failedRuns[0]?.error).toContain("Failed to fetch URL: HTTP 500");

        const pdfFailed = await api("POST", `/vaults/${id.vault}/jobs/url`, aliceToken, {
          job_id: id.m32UrlPdfRun,
          url: `${origin}/pdf`,
        });
        expect(pdfFailed.status).toBe(201);
        await waitForPipelineRun(id.m32UrlPdfRun, (row) => row.status === "failed");
        const pdfRows = await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            const runRows = yield* db.query((d) => d
              .select()
              .from(pipelineRuns)
              .where(eq(pipelineRuns.id, id.m32UrlPdfRun)))
              .pipe(Effect.orDie);
            const sourceRows = yield* db.query((d) => d
              .select()
              .from(sourceDocuments)
              .where(
                and(
                  eq(sourceDocuments.vaultId, id.vault),
                  eq(sourceDocuments.canonicalUrl, `${origin}/pdf`),
                ),
              ))
              .pipe(Effect.orDie);
            const intentRows = yield* db.query((d) => d
              .select()
              .from(compileIntents)
              .where(eq(compileIntents.pipelineRunId, id.m32UrlPdfRun)))
              .pipe(Effect.orDie);
            return { runRows, sourceRows, intentRows };
          }),
        );
        expect(pdfRows.runRows).toHaveLength(1);
        expect(pdfRows.runRows[0]).toMatchObject({
          status: "failed",
          currentPhase: "source_ingest",
          phaseStatus: "failed",
        });
        expect(pdfRows.runRows[0]?.error).toContain(
          "Unsupported URL content-type: application/pdf",
        );
        expect(pdfRows.sourceRows).toHaveLength(0);
        expect(pdfRows.intentRows).toHaveLength(0);

        const retried = await api(
          "POST",
          `/vaults/${id.vault}/jobs/${id.m32UrlFailRun}/retry`,
          aliceToken,
          { job_id: id.m32UrlRetryRun },
        );
        expect(retried.status).toBe(201);
        expect(asRecord(retried.body)).toMatchObject({
          id: id.m32UrlRetryRun,
          trigger: "url",
          status: "pending",
        });
        const retriedRun = await waitForPipelineRun(
          id.m32UrlRetryRun,
          (row) => row.status === "failed",
        );
        expect(retriedRun.error).toContain("Failed to fetch URL: HTTP 500");

        const reconciledUrl = `${origin}/reconcile`;
        await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            yield* db.query((d) => d
              .insert(pipelineRuns)
              .values({
                id: id.m32UrlReconcileRun,
                vaultId: id.vault,
                trigger: "url",
                status: "pending",
                currentPhase: "source_ingest",
                phaseStatus: "started",
                progressSteps: [],
                ingestTaskId: id.m32UrlReconcileRun,
                activeTaskId: id.m32UrlReconcileRun,
                activeTaskType: "url_ingest",
              }))
              .pipe(Effect.orDie);
            yield* db.query((d) => d
              .insert(urlIngestRequests)
              .values({
                id: id.m32UrlReconcileRun,
                createdBy: id.alice,
                canonicalUrl: reconciledUrl,
              }))
              .pipe(Effect.orDie);
            const urlIngest = yield* UrlIngestService;
            expect(yield* urlIngest.reconcileOnce()).toBe(1);
          }),
        );
        await waitForPipelineRun(
          id.m32UrlReconcileRun,
          (row) => row.phaseStatus === "completed",
        );
        const reconciledSourceId = sourceIdForKey(
          id.vault as Uuid,
          `url:${reconciledUrl}`,
        );
        expect(
          await readVaultFile(
            id.vault,
            `raw/docs/reconcile-${reconciledSourceId}.md`,
          ),
        ).toContain("Recovered URL operation body.");

        const denied = await api("POST", `/vaults/${id.vault}/jobs/url`, malloryToken, {
          job_id: "00000000-0000-4000-8000-000000013199",
          url: `${origin}/ok`,
        });
        expect(denied.status).toBe(403);
      },
    );
  });

  it("promotes exchanges through owner ingest and editor proposals with corrected 404s", async () => {
    const { aliceToken, bobToken, carolToken, malloryToken } = currentFixture();
    const sessionId = await createSessionForTest(
      id.alice as Uuid,
      "promote-key",
      {
        id: "ex-promote",
        query: "What should be promoted?",
        thinking: [],
        answer: "Promoted answer body.",
      },
      {
        doc_path: "raw/books/capital.md",
        origin_scope: "vault",
        anchor: "anchor quote",
        paragraph: "Full paragraph",
        paragraph_index: 4,
      },
    );
    currentState().clock.set(new Date("2026-07-10T12:01:00.000Z"));
    const editorSessionId = await createSessionForTest(id.bob as Uuid, "editor-promote-key", {
      id: "ex-proposal",
      query: "What should editors propose?",
      thinking: [],
      answer: "Proposal answer body.",
    });

    const ownerSourceId = sourceIdForKey(
      id.vault as Uuid,
      `session:${sessionId}:ex-promote`,
    );
    const ownerSourcePath = `raw/sessions/ex-promote-${ownerSourceId}.md`;
    const ownerPromote = await api(
      "POST",
      `/vaults/${id.vault}/sessions/${sessionId}/exchanges/ex-promote/promote`,
      aliceToken,
    );
    expect(ownerPromote.status).toBe(201);
    expect(ownerPromote.body).toEqual({
      mode: "ingested",
      path: ownerSourcePath,
      title: null,
      document_id: ownerSourceId,
      proposal_id: null,
    });
    const promotedMarkdown = await readVaultFile(id.vault, ownerSourcePath);
    expect(promotedMarkdown).toBe(
      `---\nsource_id: ${ownerSourceId}\nsource_type: session\norigin: session-exchange\nsession_id: 019f4be6-1e00-7607-8809-0a0b0c0d0e0f\nexchange_id: ex-promote\nsession_query: What should be promoted?\nsource_doc_path: raw/books/capital.md\nsource_anchor: anchor quote\nsource_paragraph_index: 4\n---\nPromoted answer body. ^p0\n`,
    );
    const promotedRows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select()
          .from(sourceDocuments)
          .where(
            and(
              eq(sourceDocuments.vaultId, id.vault),
              eq(sourceDocuments.id, ownerSourceId),
            ),
          ))
          .pipe(Effect.orDie);
      }),
    );
    expect(promotedRows).toHaveLength(1);
    expect(promotedRows[0]).toMatchObject({
      sourceType: "session",
      origin: "session-exchange",
      provenanceSessionId: sessionId,
      provenanceExchangeId: "ex-promote",
      provenanceSessionQuery: "What should be promoted?",
      provenanceSourceDocPath: "raw/books/capital.md",
      provenanceSourceAnchor: "anchor quote",
      provenanceSourceParagraphIndex: 4,
    });
    expect(await countTable(compileIntents)).toBe(1);

    const ownerReplay = await api(
      "POST",
      `/vaults/${id.vault}/sessions/${sessionId}/exchanges/ex-promote/promote`,
      aliceToken,
    );
    expect(ownerReplay.status).toBe(201);
    expect(ownerReplay.body).toMatchObject({
      mode: "ingested",
      path: ownerSourcePath,
      title: null,
      document_id: promotedRows[0]?.id,
    });

    const editorSourceId = sourceIdForKey(
      id.vault as Uuid,
      `session:${editorSessionId}:ex-proposal`,
    );
    const editorSourcePath = `raw/sessions/ex-proposal-${editorSourceId}.md`;
    const editorPromote = await api(
      "POST",
      `/vaults/${id.vault}/sessions/${editorSessionId}/exchanges/ex-proposal/promote`,
      bobToken,
    );
    expect(editorPromote.status).toBe(201);
    const editorBody = asRecord(editorPromote.body);
    expect(editorBody).toMatchObject({
      mode: "proposed",
      path: editorSourcePath,
      title: null,
    });
    const proposalId = String(editorBody.proposal_id);
    const proposalRows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select()
          .from(sourceProposals)
          .where(and(eq(sourceProposals.vaultId, id.vault), eq(sourceProposals.id, proposalId))))
          .pipe(Effect.orDie);
      }),
    );
    expect(proposalRows).toHaveLength(1);
    expect(proposalRows[0]).toMatchObject({
      status: "PENDING",
      contentType: "session",
      title: null,
      destPath: editorSourcePath,
      sourceId: editorSourceId,
    });
    const staged = await readFile(
      join(currentState().storageRoot, "proposals", `${proposalId}.md`),
      "utf8",
    );
    expect(staged).toContain("source_type: session");
    expect(staged).toContain("exchange_id: ex-proposal");
    expect(staged).toContain("Proposal answer body. ^p0");
    expect(await countTable(compileIntents)).toBe(1);

    const editorReplay = await api(
      "POST",
      `/vaults/${id.vault}/sessions/${editorSessionId}/exchanges/ex-proposal/promote`,
      bobToken,
    );
    expect(editorReplay.status).toBe(201);
    expect(editorReplay.body).toMatchObject({
      mode: "proposed",
      path: editorSourcePath,
      title: null,
      proposal_id: proposalId,
    });

    const viewerDenied = await api(
      "POST",
      `/vaults/${id.vault}/sessions/${editorSessionId}/exchanges/ex-proposal/promote`,
      carolToken,
    );
    expect(viewerDenied.status).toBe(403);
    const nonMemberDenied = await api(
      "POST",
      `/vaults/${id.vault}/sessions/${editorSessionId}/exchanges/ex-proposal/promote`,
      malloryToken,
    );
    expect(nonMemberDenied.status).toBe(403);
    const unauthenticated = await api(
      "POST",
      `/vaults/${id.vault}/sessions/${editorSessionId}/exchanges/ex-proposal/promote`,
    );
    expect(unauthenticated.status).toBe(401);

    const wrongExchange = await api(
      "POST",
      `/vaults/${id.vault}/sessions/${sessionId}/exchanges/ex-missing/promote`,
      aliceToken,
    );
    expect(wrongExchange.status).toBe(404);
    expect(wrongExchange.body).toMatchObject({ detail: "Exchange not found in session" });

    const missingSession = await api(
      "POST",
      `/vaults/${id.vault}/sessions/s-missing/exchanges/ex-any/promote`,
      aliceToken,
    );
    expect(missingSession.status).toBe(404);
    expect(missingSession.body).toMatchObject({ detail: "Session not found" });

    await writeVaultFile(id.vault, "sessions/s-empty.jsonl", "");
    const emptySession = await api(
      "POST",
      `/vaults/${id.vault}/sessions/s-empty/exchanges/ex-any/promote`,
      aliceToken,
    );
    expect(emptySession.status).toBe(404);
    expect(emptySession.body).toMatchObject({ detail: "Session not found" });

    const emptyAnswerSessionId = await createSessionForTest(
      id.alice as Uuid,
      "empty-answer-key",
      {
        id: "ex-empty",
        query: "Empty answer",
        thinking: [],
        answer: "  ",
      },
    );
    const emptyAnswer = await api(
      "POST",
      `/vaults/${id.vault}/sessions/${emptyAnswerSessionId}/exchanges/ex-empty/promote`,
      aliceToken,
    );
    expect(emptyAnswer.status).toBe(400);
    expect(emptyAnswer.body).toMatchObject({ detail: "Exchange has no answer yet" });
  });

  it("deletes vault DB cascades and local storage, including auth-owned vault cleanup", async () => {
    const { aliceToken } = currentFixture();
    await seedSourceGraph();
    await writeVaultFile(id.vault, "wiki/capital.md", "# Capital\n");
    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: id.run,
            vaultId: id.vault,
            trigger: "test",
            status: "completed",
            currentPhase: "render",
            phaseStatus: "completed",
            progressSteps: [],
          }))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
          .insert(tasks)
          .values({
            id: id.task,
            vaultId: id.vault,
            type: "compile",
            params: {},
            pipelineRunId: id.run,
          }))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
          .insert(compileIntents)
          .values({ vaultId: id.vault, pipelineRunId: id.run }))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
          .insert(compileCacheEntries)
          .values({ id: id.cache, vaultId: id.vault, phase: "extract", cacheKey: "k", value: {} }))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
          .insert(llmCostEvents)
          .values({
            id: id.cost,
            userId: id.alice,
            vaultId: id.vault,
            eventType: "query.stream",
            costUsd: "0.010000",
          }))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
          .insert(sessions)
          .values({
            id: id.session,
            vaultId: id.vault,
            userId: id.alice,
            query: "What is capital?",
            createdAt: initialTime,
            updatedAt: initialTime,
          }))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
          .insert(userDocuments)
          .values({
            id: id.reference,
            userId: id.alice,
            filePath: "references/kept.md",
            fileHash: "file-hash",
            bodyHash: "body-hash",
            title: "Kept reference",
          }))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
          .insert(shares)
          .values([
            {
              id: id.sessionShare,
              token: "session-share-token",
              subjectKind: "session",
              subjectId: id.session,
              createdBy: id.alice,
            },
            {
              id: id.referenceShare,
              token: "reference-share-token",
              subjectKind: "reference",
              subjectId: id.reference,
              createdBy: id.alice,
            },
          ]))
          .pipe(Effect.orDie);
      }),
    );

    const deleted = await api("DELETE", `/vaults/${id.vault}`, aliceToken);
    expect(deleted.status).toBe(204);
    expect(await countTable(vaults)).toBe(0);
    expect(await countTable(vaultMemberships)).toBe(0);
    expect(await countTable(sourceDocuments)).toBe(0);
    expect(await countTable(wikiArticles)).toBe(0);
    expect(await countTable(ideas)).toBe(0);
    expect(await countTable(topics)).toBe(0);
    expect(await countTable(sessions)).toBe(0);
    expect(await countTable(sourceProposals)).toBe(0);
    expect(await countTable(compileIntents)).toBe(0);
    expect(await countTable(pipelineRuns)).toBe(0);
    expect(await countTable(tasks)).toBe(0);
    expect(await countTable(searchIndex)).toBe(0);
    expect(await countTable(compileCacheEntries)).toBe(0);
    expect(await countTable(llmCostEvents)).toBe(0);
    const remainingShares = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d.select({ id: shares.id }).from(shares)).pipe(Effect.orDie);
      }),
    );
    expect(remainingShares.map((row) => row.id)).toEqual([id.referenceShare]);
    expect(await countTable(userDocuments)).toBe(1);
    expect(await fileExists(join(currentState().storageRoot, "vaults", id.vault))).toBe(false);

    await resetDatabase();
    await resetStorage();
    fixture = await seedBase();
    await writeVaultFile(id.vault, "raw/docs/auth-cleanup.md", "cleanup");
    const authDelete = await api("DELETE", "/auth/me", currentFixture().aliceToken, {
      confirm: "DELETE",
    });
    expect(authDelete.status).toBe(204);
    expect(await fileExists(join(currentState().storageRoot, "vaults", id.vault))).toBe(false);
  });
});
