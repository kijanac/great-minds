import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server as NodeServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  authCodes,
  compileCacheEntries,
  compileIntents,
  Database,
  ideas,
  llmCostEvents,
  pipelineRuns,
  searchIndex,
  sessions,
  sourceDocuments,
  sourceProposals,
  tasks,
  topicMembership,
  topics,
  users,
  vaultMemberships,
  vaults,
  wikiArticles,
} from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Effect, Layer, Option, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeAppLayer } from "../src/app-layer.ts";
import { ClockService, makeTestClock } from "../src/clock.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { bodyContentHash, fileContentHash } from "../src/crypto.ts";
import { StructuredLogger, StructuredLoggerLive } from "../src/logging.ts";
import { makeTestMailer } from "../src/mailer.ts";
import { makeTestRandomBytes } from "../src/random.ts";
import { startServer } from "../src/server.ts";
import { TokenService } from "../src/tokens.ts";

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
  m32SourceA: "00000000-0000-4000-8000-000000013001",
  m32SourceB: "00000000-0000-4000-8000-000000013002",
  m32StagedRun: "00000000-0000-4000-8000-000000013101",
  m32UrlRun: "00000000-0000-4000-8000-000000013102",
  m32UrlFailRun: "00000000-0000-4000-8000-000000013103",
  m32UrlPdfRun: "00000000-0000-4000-8000-000000013104",
} as const;

type TestServices = AppConfig | Database | ClockService | StructuredLogger | TokenService;

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
  embeddingModel: "qwen/qwen3-embedding-8b",
  corsOrigins: ["http://localhost:5173"],
  suppressAuth: false,
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

const resetDatabase = () =>
  runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.execute(sql`delete from absurd.r_default`).pipe(Effect.orDie);
      yield* db.execute(sql`delete from absurd.t_default`).pipe(Effect.orDie);
      yield* db.delete(authCodes).pipe(Effect.orDie);
      yield* db.delete(users).pipe(Effect.orDie);
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
      yield* db
        .insert(users)
        .values([
          { id: id.alice, email: "alice@example.com", createdAt: initialTime },
          { id: id.bob, email: "bob@example.com", createdAt: initialTime },
          { id: id.carol, email: "carol@example.com", createdAt: initialTime },
          { id: id.mallory, email: "mallory@example.com", createdAt: initialTime },
        ])
        .pipe(Effect.orDie);
      yield* db
        .insert(vaults)
        .values({
          id: id.vault,
          name: "Alpha Vault",
          ownerId: id.alice,
          createdAt: initialTime,
        })
        .pipe(Effect.orDie);
      yield* db
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
        ])
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
      yield* db
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
        })
        .pipe(Effect.orDie);
      yield* db
        .insert(topics)
        .values({
          topicId: id.topic,
          vaultId: id.vault,
          slug: "capital",
          title: "Capital",
          description: "Capital",
        })
        .pipe(Effect.orDie);
      yield* db
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
        ])
        .pipe(Effect.orDie);
      yield* db
        .insert(topicMembership)
        .values([
          { topicId: id.topic, ideaId: id.ideaOne },
          { topicId: id.topic, ideaId: id.ideaTwo },
        ])
        .pipe(Effect.orDie);
      yield* db
        .insert(searchIndex)
        .values({
          vaultId: id.vault,
          path: "raw/books/capital.md",
          chunkIndex: 0,
          heading: "Capital",
          body: "Capital body",
          contentHash: "chunk-hash",
          tsv: sql`to_tsvector('english', 'Capital body')`,
        })
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

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object response");
  }
  return value as Record<string, unknown>;
};

const encodeSourcePath = (filePath: string) =>
  filePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

const jsonl = (events: readonly unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n");

const readSessionEvents = async (sessionId: string) => {
  const text = await readVaultFile(id.vault, `sessions/${sessionId}.jsonl`);
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const countTable = <A>(table: A) =>
  runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      const rows = yield* db
        .select({ total: sql<number>`count(*)::int` })
        .from(table as never)
        .pipe(Effect.orDie);
      return rows[0]?.total ?? 0;
    }),
  );

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
      r2_bucket_name: null,
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
    expect(denied.body).toEqual({ detail: "Only vault owners can perform this action" });
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
        return yield* db
          .select({ role: vaultMemberships.role })
          .from(vaultMemberships)
          .where(and(eq(vaultMemberships.vaultId, id.vault), eq(vaultMemberships.userId, id.bob)))
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
    expect(missingUser.body).toEqual({ detail: "User not found" });

    const nonMember = await api("PUT", `/vaults/${id.vault}/members/${id.mallory}`, aliceToken, {
      role: "viewer",
    });
    expect(nonMember.status).toBe(404);
    expect(nonMember.body).toEqual({ detail: "User is not a member of this vault" });

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
        return yield* db
          .select({ userId: vaultMemberships.userId, role: vaultMemberships.role })
          .from(vaultMemberships)
          .where(eq(vaultMemberships.vaultId, id.vault))
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
    const encoded = encodeSourcePath("raw/books/capital.md");

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
      api("DELETE", `/vaults/${id.vault}/raw/sources/${encoded}`, malloryToken),
      api("POST", `/vaults/${id.vault}/raw/sources/${encoded}/deletion-request`, malloryToken),
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
        return yield* db
          .select({
            id: compileIntents.id,
            pipelineRunId: compileIntents.pipelineRunId,
            dispatchedAt: compileIntents.dispatchedAt,
          })
          .from(compileIntents)
          .where(and(eq(compileIntents.vaultId, id.vault), isNull(compileIntents.dispatchedAt)))
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
    const encoded = encodeSourcePath("raw/books/capital.md");

    const viewerRequest = await api(
      "POST",
      `/vaults/${id.vault}/raw/sources/${encoded}/deletion-request`,
      carolToken,
    );
    expect(viewerRequest.status).toBe(403);
    expect(viewerRequest.body).toEqual({ detail: "Viewers cannot request source deletion" });

    const ownerRequest = await api(
      "POST",
      `/vaults/${id.vault}/raw/sources/${encoded}/deletion-request`,
      aliceToken,
    );
    expect(ownerRequest.status).toBe(400);

    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(sourceProposals)
          .values({
            id: id.conflictingProposal,
            vaultId: id.vault,
            userId: id.bob,
            status: "PENDING",
            contentType: "user_suggestion",
            title: "Conflicting proposal",
            destPath: "raw/books/capital.md",
          })
          .pipe(Effect.orDie);
      }),
    );
    const conflict = await api(
      "POST",
      `/vaults/${id.vault}/raw/sources/${encoded}/deletion-request`,
      bobToken,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ detail: "A pending proposal already targets this source" });
    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .delete(sourceProposals)
          .where(eq(sourceProposals.id, id.conflictingProposal))
          .pipe(Effect.orDie);
      }),
    );

    const request = await api(
      "POST",
      `/vaults/${id.vault}/raw/sources/${encoded}/deletion-request`,
      bobToken,
    );
    expect(request.status).toBe(201);
    const deletionProposalId = String(asRecord(request.body).id);
    const duplicate = await api(
      "POST",
      `/vaults/${id.vault}/raw/sources/${encoded}/deletion-request`,
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

    await resetDatabase();
    await resetStorage();
    fixture = await seedBase();
    const { aliceToken: freshAliceToken } = currentFixture();
    await seedSourceGraph();
    const deleted = await api(
      "DELETE",
      `/vaults/${id.vault}/raw/sources/${encoded}`,
      freshAliceToken,
    );
    expect(deleted.status).toBe(204);
    expect(await countTable(sourceDocuments)).toBe(0);
    expect(await countTable(ideas)).toBe(0);
    expect(await countTable(topicMembership)).toBe(0);
    expect(await countTable(searchIndex)).toBe(0);
    expect(await vaultFileExists(id.vault, "raw/books/capital.md")).toBe(false);
    expect(await countTable(compileIntents)).toBe(0);

    const missing = await api(
      "DELETE",
      `/vaults/${id.vault}/raw/sources/${encoded}`,
      freshAliceToken,
    );
    expect(missing.status).toBe(404);
  });

  it("ingests raw markdown and direct text uploads with owner guards, frontmatter, hashes, and compile intents", async () => {
    const { aliceToken, bobToken, carolToken } = currentFixture();
    const raw = await api("POST", `/vaults/${id.vault}/ingest`, aliceToken, {
      content: "# Raw Title\n\nRaw body paragraph.",
      dest: "raw/docs/raw-direct.md",
      origin: "fixture",
    });
    expect(raw.status).toBe(201);
    expect(raw.body).toEqual({ file_path: "raw/docs/raw-direct.md" });
    const rawText = await readVaultFile(id.vault, "raw/docs/raw-direct.md");
    expect(rawText).toBe(
      "---\nsource_type: document\norigin: fixture\n---\n# Raw Title\n\nRaw body paragraph. ^p0\n",
    );

    const rawRows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db
          .select()
          .from(sourceDocuments)
          .where(
            and(
              eq(sourceDocuments.vaultId, id.vault),
              eq(sourceDocuments.filePath, "raw/docs/raw-direct.md"),
            ),
          )
          .pipe(Effect.orDie);
      }),
    );
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0]).toMatchObject({
      sourceType: "document",
      origin: "fixture",
      fileHash: fileContentHash(rawText),
      bodyHash: bodyContentHash("# Raw Title\n\nRaw body paragraph. ^p0\n"),
    });
    expect(await countTable(compileIntents)).toBe(1);

    const editorDenied = await api("POST", `/vaults/${id.vault}/ingest`, bobToken, {
      content: "Denied",
      dest: "raw/docs/denied.md",
    });
    expect(editorDenied.status).toBe(403);

    const viewerDeniedUpload = new FormData();
    viewerDeniedUpload.append("file", new Blob(["viewer"], { type: "text/plain" }), "viewer.txt");
    const viewerUpload = await uploadApi(
      `/vaults/${id.vault}/ingest/upload`,
      carolToken,
      viewerDeniedUpload,
    );
    expect(viewerUpload.status).toBe(403);

    const invalidVaultUpload = new FormData();
    invalidVaultUpload.append(
      "file",
      new Blob(["bad vault"], { type: "text/plain" }),
      "bad-vault.txt",
    );
    const invalidVault = await uploadApi(
      "/vaults/not-a-uuid/ingest/upload",
      aliceToken,
      invalidVaultUpload,
    );
    expect(invalidVault.status).toBe(422);
    expect(invalidVault.body).toEqual({ detail: "Invalid path parameter" });

    const missingFile = await uploadApi(
      `/vaults/${id.vault}/ingest/upload`,
      aliceToken,
      new FormData(),
    );
    expect(missingFile.status).toBe(400);
    expect(missingFile.body).toEqual({ detail: "Uploaded file must have a filename" });

    const form = new FormData();
    form.append(
      "file",
      new Blob(["# Uploaded\n\nUploaded paragraph."], { type: "text/plain" }),
      "uploaded.txt",
    );
    const uploaded = await uploadApi(
      `/vaults/${id.vault}/ingest/upload?dest_path=uploads/custom-name.txt&origin=manual`,
      aliceToken,
      form,
    );
    expect(uploaded.status).toBe(201);
    expect(uploaded.body).toEqual({ file_path: "raw/docs/uploads/custom-name.md" });
    const uploadedText = await readVaultFile(id.vault, "raw/docs/uploads/custom-name.md");
    expect(uploadedText).toContain("origin: manual");
    expect(uploadedText).toContain("Uploaded paragraph. ^p0");

    const htmlForm = new FormData();
    htmlForm.append(
      "file",
      new Blob(
        [
          "<html><head><title>HTML Upload</title></head><body><main><h1>HTML Upload</h1><p>Converted upload paragraph.</p></main></body></html>",
        ],
        { type: "text/html" },
      ),
      "html-upload.html",
    );
    const htmlUpload = await uploadApi(
      `/vaults/${id.vault}/ingest/upload?origin=html-fixture`,
      aliceToken,
      htmlForm,
    );
    expect(htmlUpload.status).toBe(201);
    expect(htmlUpload.body).toEqual({ file_path: "raw/docs/html-upload.md" });
    const htmlText = await readVaultFile(id.vault, "raw/docs/html-upload.md");
    expect(htmlText).toBe(
      "---\nsource_type: document\norigin: html-fixture\n---\n# HTML Upload\n\nConverted upload paragraph. ^p0\n",
    );
    const htmlRows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db
          .select()
          .from(sourceDocuments)
          .where(
            and(
              eq(sourceDocuments.vaultId, id.vault),
              eq(sourceDocuments.filePath, "raw/docs/html-upload.md"),
            ),
          )
          .pipe(Effect.orDie);
      }),
    );
    expect(htmlRows[0]).toMatchObject({
      fileHash: fileContentHash(htmlText),
      bodyHash: bodyContentHash("# HTML Upload\n\nConverted upload paragraph. ^p0\n"),
    });

    const badDest = new FormData();
    badDest.append("file", new Blob(["bad"], { type: "text/plain" }), "bad.txt");
    const badUpload = await uploadApi(
      `/vaults/${id.vault}/ingest/upload?dest_path=../bad.md`,
      aliceToken,
      badDest,
    );
    expect(badUpload.status).toBe(400);
    expect(badUpload.body).toEqual({ detail: "Invalid dest_path: ../bad.md" });
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
      const editorPath = String(asRecord(editor.body).file_path);
      const proposalRows = await runDb(
        Effect.gen(function* () {
          const db = yield* Database;
          return yield* db
            .select()
            .from(sourceProposals)
            .where(
              and(eq(sourceProposals.vaultId, id.vault), eq(sourceProposals.destPath, editorPath)),
            )
            .pipe(Effect.orDie);
        }),
      );
      expect(proposalRows).toHaveLength(1);
      expect(proposalRows[0]).toMatchObject({
        status: "PENDING",
        contentType: "user_suggestion",
        documentId: null,
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
    expect(blank.body).toEqual({ detail: "body is empty" });

    const viewer = await api("POST", `/vaults/${id.vault}/ingest/user-suggestion`, carolToken, {
      body: "Viewer suggestion",
      intent: "correct",
    });
    expect(viewer.status).toBe(403);
  });

  it("handles staged-file dedupe, local signing errors, process enqueue, and zero route-level compile intents", async () => {
    const { aliceToken, bobToken } = currentFixture();
    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(sourceDocuments)
          .values([
            {
              id: id.m32SourceA,
              vaultId: id.vault,
              filePath: "raw/docs/a.md",
              fileHash: "file-a",
              bodyHash: "body-a",
              clientHash: "hash-a",
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
              clientHash: "hash-a",
              sourceType: "document",
              tags: [],
              derivedExtras: {},
            },
          ])
          .pipe(Effect.orDie);
      }),
    );

    const dupes = await api(
      "POST",
      `/vaults/${id.vault}/ingest/staged-files/check-dupes`,
      aliceToken,
      {
        client_hashes: ["hash-a", "hash-b"],
      },
    );
    expect(dupes.status).toBe(200);
    expect(asRecord(dupes.body).existing).toEqual(["hash-a", "hash-a"]);

    const editorDupes = await api(
      "POST",
      `/vaults/${id.vault}/ingest/staged-files/check-dupes`,
      bobToken,
      {
        client_hashes: ["hash-a"],
      },
    );
    expect(editorDupes.status).toBe(403);

    const localSign = await api(
      "POST",
      `/vaults/${id.vault}/ingest/staged-files/sign`,
      aliceToken,
      {
        files: [{ name: "a.md", size: 10, hash: "hash-a", mimetype: "text/markdown" }],
      },
    );
    expect(localSign.status).toBe(400);
    expect(localSign.body).toEqual({ detail: "vault has no r2 bucket; cannot sign uploads" });

    const emptyProcess = await api(
      "POST",
      `/vaults/${id.vault}/ingest/staged-files/process`,
      aliceToken,
      {
        job_id: id.m32StagedRun,
        files: [],
      },
    );
    expect(emptyProcess.status).toBe(400);
    expect(emptyProcess.body).toEqual({ detail: "no files provided" });

    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.delete(sourceDocuments).pipe(Effect.orDie);
      }),
    );
    const processed = await api(
      "POST",
      `/vaults/${id.vault}/ingest/staged-files/process`,
      aliceToken,
      {
        job_id: id.m32StagedRun,
        files: [{ name: "a.md", size: 10, hash: "hash-a", mimetype: "text/markdown" }],
      },
    );
    expect(processed.status).toBe(200);
    const processedBody = asRecord(processed.body);
    expect(processedBody).toMatchObject({
      id: id.m32StagedRun,
      vault_id: id.vault,
      trigger: "staged_files",
      stream_url: `/jobs/${id.m32StagedRun}/stream`,
    });

    const rows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        const appTasks = yield* db
          .select()
          .from(tasks)
          .where(eq(tasks.pipelineRunId, id.m32StagedRun))
          .pipe(Effect.orDie);
        const runs = yield* db
          .select()
          .from(pipelineRuns)
          .where(eq(pipelineRuns.id, id.m32StagedRun))
          .pipe(Effect.orDie);
        const absurdTasks = yield* db
          .execute(sql<{ task_name: string; params: unknown; idempotency_key: string }>`
            select task_name, params, idempotency_key
            from absurd.t_default
            where idempotency_key = ${id.m32StagedRun}
          `)
          .pipe(Effect.orDie);
        return {
          appTasks,
          runs,
          absurdTasks: (
            absurdTasks as unknown as {
              readonly rows: readonly {
                readonly task_name: string;
                readonly params: unknown;
                readonly idempotency_key: string;
              }[];
            }
          ).rows,
        };
      }),
    );
    expect(rows.appTasks).toHaveLength(1);
    expect(rows.appTasks[0]).toMatchObject({
      type: "staged_file_ingest",
      vaultId: id.vault,
      pipelineRunId: id.m32StagedRun,
    });
    expect(rows.runs[0]).toMatchObject({
      ingestTaskId: rows.appTasks[0]!.id,
      activeTaskId: rows.appTasks[0]!.id,
      activeTaskType: "staged_file_ingest",
    });
    expect(rows.absurdTasks).toHaveLength(1);
    expect(rows.absurdTasks[0]).toMatchObject({
      task_name: "staged_file_ingest",
      idempotency_key: id.m32StagedRun,
    });
    expect(rows.absurdTasks[0]?.params).toEqual({
      vault_id: id.vault,
      files: [{ name: "a.md", size: 10, hash: "hash-a", mimetype: "text/markdown" }],
      pipeline_run_id: id.m32StagedRun,
    });
    expect(await countTable(compileIntents)).toBe(0);
  });

  it("runs jobs/url synchronously with member guard, clean markdown conversion, attached compile intent, and persisted failures", async () => {
    const { aliceToken, carolToken, malloryToken } = currentFixture();
    await withLocalHttpServer(
      (request, response) => {
        if (request.url === "/ok") {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            "<html><head><title>Local Article</title></head><body><main><h1>Local Article</h1><p>Converted paragraph.</p></main></body></html>",
          );
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
        const viewerSuccess = await api("POST", `/vaults/${id.vault}/jobs/url`, carolToken, {
          job_id: id.m32UrlRun,
          url: `${origin}/ok`,
        });
        expect(viewerSuccess.status).toBe(201);
        expect(asRecord(viewerSuccess.body)).toMatchObject({
          id: id.m32UrlRun,
          trigger: "url",
          current_phase: "source_ingest",
          phase_status: "completed",
          stream_url: `/jobs/${id.m32UrlRun}/stream`,
        });

        const markdown = await readVaultFile(id.vault, "raw/docs/ok.md");
        expect(markdown).toContain("source_type: document");
        expect(markdown).toContain(`url: ${origin}/ok`);
        expect(markdown).toContain("origin: 127.0.0.1:");
        expect(markdown).toContain("# Local Article");
        expect(markdown).toContain("Converted paragraph. ^p0");

        const successRows = await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            const sourceRows = yield* db
              .select()
              .from(sourceDocuments)
              .where(
                and(
                  eq(sourceDocuments.vaultId, id.vault),
                  eq(sourceDocuments.filePath, "raw/docs/ok.md"),
                ),
              )
              .pipe(Effect.orDie);
            const intentRows = yield* db
              .select()
              .from(compileIntents)
              .where(eq(compileIntents.pipelineRunId, id.m32UrlRun))
              .pipe(Effect.orDie);
            const runRows = yield* db
              .select()
              .from(pipelineRuns)
              .where(eq(pipelineRuns.id, id.m32UrlRun))
              .pipe(Effect.orDie);
            return { sourceRows, intentRows, runRows };
          }),
        );
        expect(successRows.sourceRows).toHaveLength(1);
        expect(successRows.sourceRows[0]).toMatchObject({
          sourceType: "document",
          url: `${origin}/ok`,
        });
        expect(successRows.intentRows).toHaveLength(1);
        expect(successRows.runRows[0]?.compileIntentId).toBe(successRows.intentRows[0]?.id);

        const failed = await api("POST", `/vaults/${id.vault}/jobs/url`, aliceToken, {
          job_id: id.m32UrlFailRun,
          url: `${origin}/fail`,
        });
        expect(failed.status).toBe(400);
        expect(String(asRecord(failed.body).detail)).toContain("Failed to fetch URL: HTTP 500");
        const failedRuns = await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            return yield* db
              .select()
              .from(pipelineRuns)
              .where(eq(pipelineRuns.id, id.m32UrlFailRun))
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
        expect(pdfFailed.status).toBe(400);
        expect(String(asRecord(pdfFailed.body).detail)).toContain(
          "Unsupported URL content-type: application/pdf",
        );
        const pdfRows = await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            const runRows = yield* db
              .select()
              .from(pipelineRuns)
              .where(eq(pipelineRuns.id, id.m32UrlPdfRun))
              .pipe(Effect.orDie);
            const sourceRows = yield* db
              .select()
              .from(sourceDocuments)
              .where(
                and(
                  eq(sourceDocuments.vaultId, id.vault),
                  eq(sourceDocuments.filePath, "raw/docs/pdf.md"),
                ),
              )
              .pipe(Effect.orDie);
            const intentRows = yield* db
              .select()
              .from(compileIntents)
              .where(eq(compileIntents.pipelineRunId, id.m32UrlPdfRun))
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

        const denied = await api("POST", `/vaults/${id.vault}/jobs/url`, malloryToken, {
          job_id: "00000000-0000-4000-8000-000000013199",
          url: `${origin}/ok`,
        });
        expect(denied.status).toBe(403);
      },
    );
  });

  it("creates sessions with uuid7 ids, idempotent replay, spin-off origins, and member guards", async () => {
    const { aliceToken, carolToken, malloryToken } = currentFixture();
    const firstExchange = {
      id: "ex-first",
      query: "How should organizers read sources?",
      thinking: [],
      answer: "Read for claims and evidence.",
    };

    const created = await api("POST", `/vaults/${id.vault}/sessions`, aliceToken, {
      idempotency_key: "stable-create-key",
      exchange: firstExchange,
      origin: null,
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: "019f4be6-1e00-7607-8809-0a0b0c0d0e0f",
      path: "sessions/019f4be6-1e00-7607-8809-0a0b0c0d0e0f.jsonl",
    });
    expect(String(asRecord(created.body).id)[14]).toBe("7");
    const createdRows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db
          .select()
          .from(sessions)
          .where(eq(sessions.id, String(asRecord(created.body).id)))
          .pipe(Effect.orDie);
      }),
    );
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0]).toMatchObject({
      query: firstExchange.query,
      origin: null,
      idempotencyKey: "stable-create-key",
      createdAt: initialTime,
    });

    const replay = await api("POST", `/vaults/${id.vault}/sessions`, aliceToken, {
      idempotency_key: "stable-create-key",
      exchange: firstExchange,
      origin: null,
    });
    expect(replay.status).toBe(201);
    expect(asRecord(replay.body).id).toBe(asRecord(created.body).id);
    expect(await readSessionEvents(String(asRecord(created.body).id))).toHaveLength(2);

    const replayWithLaterExchange = await api("POST", `/vaults/${id.vault}/sessions`, aliceToken, {
      idempotency_key: "stable-create-key",
      exchange: {
        id: "ex-later",
        query: "What comes after the first question?",
        thinking: [],
        answer: "The retry appends a distinct completed exchange once.",
      },
      origin: null,
    });
    expect(replayWithLaterExchange.status).toBe(201);
    expect(asRecord(replayWithLaterExchange.body).id).toBe(asRecord(created.body).id);
    const replayEvents = await readSessionEvents(String(asRecord(created.body).id));
    expect(replayEvents.map((event) => event.type)).toEqual(["meta", "exchange", "exchange"]);

    await rm(
      join(currentState().storageRoot, "vaults", id.vault, String(asRecord(created.body).path)),
    );
    const corruptReplay = await api("POST", `/vaults/${id.vault}/sessions`, aliceToken, {
      idempotency_key: "stable-create-key",
      exchange: {
        id: "ex-corrupt-replay",
        query: "Can a missing event log be recreated?",
        thinking: [],
        answer: "No; the database/file invariant is corrupt.",
      },
      origin: null,
    });
    expect(corruptReplay.status).toBe(500);
    expect(await vaultFileExists(id.vault, String(asRecord(created.body).path))).toBe(false);

    const spinOff = await api("POST", `/vaults/${id.vault}/sessions`, aliceToken, {
      idempotency_key: "fresh-spin-off-key",
      exchange: {
        id: "ex-spin",
        query: "Why this highlighted passage?",
        thinking: [],
        answer: "Because it carries the document-level claim.",
      },
      origin: { doc_path: "raw/books/capital.md", anchor: "highlighted passage" },
    });
    expect(spinOff.status).toBe(201);
    expect(spinOff.body).toEqual({
      id: "019f4be6-1e00-7617-9819-1a1b1c1d1e1f",
      path: "sessions/019f4be6-1e00-7617-9819-1a1b1c1d1e1f.jsonl",
    });
    const spinOffEvents = await readSessionEvents(String(asRecord(spinOff.body).id));
    expect(spinOffEvents[0]).toMatchObject({
      type: "meta",
      origin: {
        doc_path: "raw/books/capital.md",
        anchor: "highlighted passage",
        paragraph: null,
        paragraph_index: null,
      },
    });

    const viewerCreate = await api("POST", `/vaults/${id.vault}/sessions`, carolToken, {
      idempotency_key: "viewer-key",
      exchange: {
        id: "ex-viewer",
        query: "Can viewers persist sessions?",
        thinking: [],
        answer: "Yes, any vault member can create a session.",
      },
    });
    expect(viewerCreate.status).toBe(201);
    expect(asRecord(viewerCreate.body).id).toBe("019f4be6-1e00-7627-a829-2a2b2c2d2e2f");

    const nonMember = await api("POST", `/vaults/${id.vault}/sessions`, malloryToken, {
      idempotency_key: "blocked-key",
      exchange: firstExchange,
    });
    expect(nonMember.status).toBe(403);

    const unauthenticated = await api("POST", `/vaults/${id.vault}/sessions`, undefined, {
      idempotency_key: "anonymous-key",
      exchange: firstExchange,
    });
    expect(unauthenticated.status).toBe(401);
  });

  it("appends exchanges and BTW context, and rebuilds Python-parity markdown sidecars", async () => {
    const { aliceToken, bobToken, carolToken, malloryToken } = currentFixture();
    const created = await api("POST", `/vaults/${id.vault}/sessions`, aliceToken, {
      idempotency_key: "sidecar-key",
      exchange: {
        id: "ex-sidecar",
        query: "How should organizers read sources?",
        thinking: [
          {
            sources: [{ label: "Capital Volume", type: "raw", thinking: null }],
          },
        ],
        answer: "Start with the passage and its claim.",
      },
    });
    const sessionId = String(asRecord(created.body).id);

    currentState().clock.set(new Date("2026-07-10T12:01:00.000Z"));
    const firstBtw = await api("PATCH", `/vaults/${id.vault}/sessions/${sessionId}/btw`, bobToken, {
      quote: "the passage",
      blockOffset: 0,
      context: "Start with the passage and its claim.",
      exchangeId: "ex-sidecar",
      exchanges: [
        {
          query: "Why that passage?",
          thinking: [],
          answer: "Because it gives the group something concrete.",
        },
      ],
    });
    expect(firstBtw.status).toBe(200);
    const updatedAt = async () =>
      runDb(
        Effect.gen(function* () {
          const db = yield* Database;
          const rows = yield* db
            .select({ updatedAt: sessions.updatedAt })
            .from(sessions)
            .where(and(eq(sessions.vaultId, id.vault), eq(sessions.id, sessionId)))
            .pipe(Effect.orDie);
          return rows[0]?.updatedAt;
        }),
      );
    expect(await updatedAt()).toEqual(new Date("2026-07-10T12:01:00.000Z"));

    currentState().clock.set(new Date("2026-07-10T12:02:00.000Z"));
    const secondBtw = await api(
      "PATCH",
      `/vaults/${id.vault}/sessions/${sessionId}/btw`,
      bobToken,
      {
        quote: "the passage",
        blockOffset: 0,
        context: "Start with the passage and its claim.",
        exchangeId: "ex-sidecar",
        exchanges: [
          {
            query: "Why that passage?",
            thinking: [],
            answer: "Because it anchors the discussion.",
          },
          {
            query: "What if people disagree?",
            thinking: [],
            answer: "Let the disagreement name the claim.",
          },
        ],
      },
    );
    expect(secondBtw.status).toBe(200);
    expect(await updatedAt()).toEqual(new Date("2026-07-10T12:02:00.000Z"));

    currentState().clock.set(new Date("2026-07-10T12:03:00.000Z"));
    const appended = await api("PATCH", `/vaults/${id.vault}/sessions/${sessionId}`, carolToken, {
      id: "ex-follow-up",
      query: "What should they record?",
      thinking: [],
      answer: "Record the quote and open questions.",
    });
    expect(appended.status).toBe(200);
    expect(appended.body).toEqual({ path: `sessions/${sessionId}.jsonl` });
    expect(await updatedAt()).toEqual(new Date("2026-07-10T12:03:00.000Z"));

    for (const [suffix, token, status] of [
      ["", malloryToken, 403],
      ["", undefined, 401],
      ["/btw", malloryToken, 403],
      ["/btw", undefined, 401],
    ] as const) {
      const denied = await api(
        "PATCH",
        `/vaults/${id.vault}/sessions/${sessionId}${suffix}`,
        token,
        suffix === "/btw"
          ? {
              quote: "blocked",
              blockOffset: 0,
              context: "blocked",
              exchangeId: "ex-sidecar",
              exchanges: [],
            }
          : {
              id: "ex-blocked",
              query: "Blocked?",
              thinking: [],
              answer: "Yes.",
            },
      );
      expect(denied.status).toBe(status);
    }

    const events = await readSessionEvents(sessionId);
    expect(events).toHaveLength(5);
    expect(events[3]).toMatchObject({
      type: "btw",
      context: "Start with the passage and its claim.",
      exchanges: [
        { query: "Why that passage?", answer: "Because it anchors the discussion." },
        { query: "What if people disagree?", answer: "Let the disagreement name the claim." },
      ],
    });

    const replay = await api("GET", `/vaults/${id.vault}/sessions/${sessionId}`, aliceToken);
    expect(replay.status).toBe(200);
    const replayEvents = asRecord(replay.body).events;
    expect(Array.isArray(replayEvents)).toBe(true);
    expect((replayEvents as readonly Record<string, unknown>[])[3]).toMatchObject({
      type: "btw",
      context: "Start with the passage and its claim.",
    });

    const expected = await readFile(
      new URL("./fixtures/session-sidecar.expected.md", import.meta.url),
      "utf8",
    );
    expect(await readVaultFile(id.vault, `sessions/${sessionId}.md`)).toBe(expected);

    const orphan = await api("PATCH", `/vaults/${id.vault}/sessions/orphan-session`, bobToken, {
      id: "ex-orphan",
      query: "Can append create storage?",
      thinking: [],
      answer: "Append creates JSONL and sidecar storage without an overview row.",
    });
    expect(orphan.status).toBe(200);
    expect(await vaultFileExists(id.vault, "sessions/orphan-session.jsonl")).toBe(true);
    expect(await vaultFileExists(id.vault, "sessions/orphan-session.md")).toBe(true);
    const orphanRows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db
          .select()
          .from(sessions)
          .where(and(eq(sessions.vaultId, id.vault), eq(sessions.id, "orphan-session")))
          .pipe(Effect.orDie);
      }),
    );
    expect(orphanRows).toHaveLength(0);
  });

  it("promotes exchanges through owner ingest and editor proposals with corrected 404s", async () => {
    const { aliceToken, bobToken, carolToken, malloryToken } = currentFixture();
    const created = await api("POST", `/vaults/${id.vault}/sessions`, aliceToken, {
      idempotency_key: "promote-key",
      exchange: {
        id: "ex-promote",
        query: "What should be promoted?",
        thinking: [],
        answer: "Promoted answer body.",
      },
      origin: {
        doc_path: "raw/books/capital.md",
        anchor: "anchor quote",
        paragraph: "Full paragraph",
        paragraph_index: 4,
      },
    });
    const sessionId = String(asRecord(created.body).id);
    currentState().clock.set(new Date("2026-07-10T12:01:00.000Z"));
    const proposalExchange = await api(
      "PATCH",
      `/vaults/${id.vault}/sessions/${sessionId}`,
      aliceToken,
      {
        id: "ex-proposal",
        query: "What should editors propose?",
        thinking: [],
        answer: "Proposal answer body.",
      },
    );
    expect(proposalExchange.status).toBe(200);

    const ownerPromote = await api(
      "POST",
      `/vaults/${id.vault}/sessions/${sessionId}/exchanges/ex-promote/promote`,
      aliceToken,
    );
    expect(ownerPromote.status).toBe(201);
    expect(ownerPromote.body).toEqual({
      mode: "ingested",
      path: "raw/sessions/ex-promote.md",
      title: null,
      document_id: null,
      proposal_id: null,
    });
    const promotedMarkdown = await readVaultFile(id.vault, "raw/sessions/ex-promote.md");
    expect(promotedMarkdown).toBe(
      "---\nsource_type: session\norigin: session-exchange\nsession_id: 019f4be6-1e00-7607-8809-0a0b0c0d0e0f\nexchange_id: ex-promote\nsession_query: What should be promoted?\nsource_doc_path: raw/books/capital.md\nsource_anchor: anchor quote\nsource_paragraph_index: 4\n---\nPromoted answer body. ^p0\n",
    );
    const promotedRows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db
          .select()
          .from(sourceDocuments)
          .where(
            and(
              eq(sourceDocuments.vaultId, id.vault),
              eq(sourceDocuments.filePath, "raw/sessions/ex-promote.md"),
            ),
          )
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
      path: "raw/sessions/ex-promote.md",
      title: "ex-promote",
      document_id: promotedRows[0]?.id,
    });

    const editorPromote = await api(
      "POST",
      `/vaults/${id.vault}/sessions/${sessionId}/exchanges/ex-proposal/promote`,
      bobToken,
    );
    expect(editorPromote.status).toBe(201);
    const editorBody = asRecord(editorPromote.body);
    expect(editorBody).toMatchObject({
      mode: "proposed",
      path: "raw/sessions/ex-proposal.md",
      title: null,
    });
    const proposalId = String(editorBody.proposal_id);
    const proposalRows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db
          .select()
          .from(sourceProposals)
          .where(and(eq(sourceProposals.vaultId, id.vault), eq(sourceProposals.id, proposalId)))
          .pipe(Effect.orDie);
      }),
    );
    expect(proposalRows).toHaveLength(1);
    expect(proposalRows[0]).toMatchObject({
      status: "PENDING",
      contentType: "session",
      title: null,
      destPath: "raw/sessions/ex-proposal.md",
      documentId: null,
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
      `/vaults/${id.vault}/sessions/${sessionId}/exchanges/ex-proposal/promote`,
      bobToken,
    );
    expect(editorReplay.status).toBe(201);
    expect(editorReplay.body).toMatchObject({
      mode: "proposed",
      path: "raw/sessions/ex-proposal.md",
      title: "ex-proposal",
      proposal_id: proposalId,
    });

    const viewerDenied = await api(
      "POST",
      `/vaults/${id.vault}/sessions/${sessionId}/exchanges/ex-proposal/promote`,
      carolToken,
    );
    expect(viewerDenied.status).toBe(403);
    const nonMemberDenied = await api(
      "POST",
      `/vaults/${id.vault}/sessions/${sessionId}/exchanges/ex-proposal/promote`,
      malloryToken,
    );
    expect(nonMemberDenied.status).toBe(403);
    const unauthenticated = await api(
      "POST",
      `/vaults/${id.vault}/sessions/${sessionId}/exchanges/ex-proposal/promote`,
    );
    expect(unauthenticated.status).toBe(401);

    const wrongExchange = await api(
      "POST",
      `/vaults/${id.vault}/sessions/${sessionId}/exchanges/ex-missing/promote`,
      aliceToken,
    );
    expect(wrongExchange.status).toBe(404);
    expect(wrongExchange.body).toEqual({ detail: "Exchange not found in session" });

    const missingSession = await api(
      "POST",
      `/vaults/${id.vault}/sessions/s-missing/exchanges/ex-any/promote`,
      aliceToken,
    );
    expect(missingSession.status).toBe(404);
    expect(missingSession.body).toEqual({ detail: "Session not found" });

    await writeVaultFile(id.vault, "sessions/s-empty.jsonl", "");
    const emptySession = await api(
      "POST",
      `/vaults/${id.vault}/sessions/s-empty/exchanges/ex-any/promote`,
      aliceToken,
    );
    expect(emptySession.status).toBe(404);
    expect(emptySession.body).toEqual({ detail: "Session not found" });

    await writeVaultFile(
      id.vault,
      "sessions/s-empty-answer.jsonl",
      jsonl([
        {
          type: "meta",
          id: "s-empty-answer",
          query: "Empty answer",
          ts: "2026-07-10T12:00:00.000Z",
          user_id: id.alice,
          origin: null,
        },
        {
          type: "exchange",
          exId: "ex-empty",
          query: "Empty answer",
          thinking: [],
          answer: "  ",
          ts: "2026-07-10T12:00:00.000Z",
        },
      ]),
    );
    const emptyAnswer = await api(
      "POST",
      `/vaults/${id.vault}/sessions/s-empty-answer/exchanges/ex-empty/promote`,
      aliceToken,
    );
    expect(emptyAnswer.status).toBe(400);
    expect(emptyAnswer.body).toEqual({ detail: "Exchange has no answer yet" });
  });

  it("deletes vault DB cascades and local storage, including auth-owned vault cleanup", async () => {
    const { aliceToken } = currentFixture();
    await seedSourceGraph();
    await writeVaultFile(id.vault, "wiki/capital.md", "# Capital\n");
    await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(pipelineRuns)
          .values({
            id: id.run,
            vaultId: id.vault,
            trigger: "test",
            status: "completed",
            currentPhase: "render",
            phaseStatus: "completed",
            progressSteps: [],
          })
          .pipe(Effect.orDie);
        yield* db
          .insert(tasks)
          .values({
            id: id.task,
            vaultId: id.vault,
            type: "compile",
            params: {},
            pipelineRunId: id.run,
          })
          .pipe(Effect.orDie);
        yield* db
          .insert(compileIntents)
          .values({ vaultId: id.vault, pipelineRunId: id.run })
          .pipe(Effect.orDie);
        yield* db
          .insert(compileCacheEntries)
          .values({ id: id.cache, vaultId: id.vault, phase: "extract", cacheKey: "k", value: {} })
          .pipe(Effect.orDie);
        yield* db
          .insert(llmCostEvents)
          .values({
            id: id.cost,
            userId: id.alice,
            vaultId: id.vault,
            eventType: "query.stream",
            costUsd: "0.010000",
          })
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
