import {
  apiKeys,
  authCodes,
  Database,
  pipelineRuns,
  sourceDocuments,
  topics,
  users,
  vaultMemberships,
  vaults,
  wikiArticles
} from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
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
  apiKeyAlice: "00000000-0000-4000-8000-000000000601"
} as const;

const aliceApiKey = "gm_alice_read_key";

type TestServices = AppConfig | Database | ClockService | StructuredLogger | TokenService;

type TestState = {
  readonly started: Awaited<ReturnType<typeof startServer>>;
  readonly clock: ReturnType<typeof makeTestClock>;
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

const testConfig = (url: string): AppConfigShape => ({
  databaseUrl: Redacted.make(url),
  jwtSecret: Redacted.make("integration-test-jwt-secret"),
  jwtAccessExpiryMinutes: 30,
  jwtRefreshExpiryDays: 7,
  authCodeExpiryMinutes: 10,
  resendApiKey: Redacted.make("integration-test-resend-key"),
  resendFromEmail: "login@example.test",
  storageBackend: "local",
  r2AccountId: Option.none(),
  r2AccessKeyId: Option.none(),
  r2SecretAccessKey: Option.none(),
  r2BucketPrefix: "gm-test",
  suppressAuth: false,
  serverHost: "127.0.0.1",
  serverPort: 0
});

const buildTestState = async () => {
  const clock = makeTestClock(initialTime);
  const configLayer = Layer.succeed(AppConfig, testConfig(databaseUrl()));
  const appLayer = makeAppLayer({
    config: configLayer,
    clock: clock.layer,
    mailer: makeTestMailer().layer,
    logger: StructuredLoggerLive
  });
  const started = await startServer({ layer: appLayer, host: "127.0.0.1", port: 0 });
  return { started, clock } satisfies TestState;
};

const runDb = <A>(effect: Effect.Effect<A, unknown, TestServices>) =>
  currentState().started.runtime.runPromise(effect);

const resetDatabase = () =>
  runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.delete(authCodes).pipe(Effect.orDie);
      yield* db.delete(users).pipe(Effect.orDie);
    })
  );

const issueToken = (userId: string) =>
  runDb(
    Effect.gen(function* () {
      const tokens = yield* TokenService;
      return yield* tokens.issueAccessToken(userId as Uuid, initialTime);
    })
  );

const seedFixtures = async (): Promise<Fixture> => {
  await runDb(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db
        .insert(users)
        .values([
          { id: id.alice, email: "alice@example.com", createdAt: new Date("2026-07-01T00:00:00.000Z") },
          { id: id.bob, email: "bob@example.com", createdAt: new Date("2026-07-01T00:01:00.000Z") },
          {
            id: id.mallory,
            email: "mallory@example.com",
            createdAt: new Date("2026-07-01T00:02:00.000Z")
          }
        ])
        .pipe(Effect.orDie);
      yield* db
        .insert(vaults)
        .values([
          {
            id: id.vaultAlpha,
            name: "Alpha Vault",
            ownerId: id.alice,
            createdAt: new Date("2026-07-02T00:00:00.000Z")
          },
          {
            id: id.vaultBeta,
            name: "Beta Vault",
            ownerId: id.bob,
            createdAt: new Date("2026-07-03T00:00:00.000Z"),
            r2BucketName: "beta-bucket"
          }
        ])
        .pipe(Effect.orDie);
      yield* db
        .insert(vaultMemberships)
        .values([
          {
            id: "00000000-0000-4000-8000-000000000701",
            vaultId: id.vaultAlpha,
            userId: id.alice,
            role: "OWNER"
          },
          {
            id: "00000000-0000-4000-8000-000000000702",
            vaultId: id.vaultAlpha,
            userId: id.bob,
            role: "EDITOR"
          },
          {
            id: "00000000-0000-4000-8000-000000000703",
            vaultId: id.vaultBeta,
            userId: id.bob,
            role: "OWNER"
          },
          {
            id: "00000000-0000-4000-8000-000000000704",
            vaultId: id.vaultBeta,
            userId: id.alice,
            role: "VIEWER"
          }
        ])
        .pipe(Effect.orDie);
      yield* db
        .insert(apiKeys)
        .values({
          id: id.apiKeyAlice,
          userId: id.alice,
          keyHash: sha256Hex(aliceApiKey),
          label: "read automation",
          revoked: false,
          createdAt: new Date("2026-07-04T00:00:00.000Z")
        })
        .pipe(Effect.orDie);
      yield* db
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
          updatedAt: new Date("2026-07-05T01:00:00.000Z")
        })
        .pipe(Effect.orDie);
      yield* db
        .insert(topics)
        .values([
          {
            topicId: id.topicAlpha,
            vaultId: id.vaultAlpha,
            slug: "alpha-practice",
            title: "alpha Practice",
            description: "Alpha"
          },
          {
            topicId: id.topicBeta,
            vaultId: id.vaultAlpha,
            slug: "beta-theory",
            title: "Beta Theory",
            description: "Beta"
          },
          {
            topicId: id.topicGamma,
            vaultId: id.vaultAlpha,
            slug: "gamma-lines",
            title: "gamma Lines",
            description: "Gamma"
          },
          {
            topicId: id.topicIndex,
            vaultId: id.vaultAlpha,
            slug: "_index",
            title: "Index",
            description: "Index"
          },
          {
            topicId: id.topicArchived,
            vaultId: id.vaultAlpha,
            slug: "archived-essay",
            title: "Archived Essay",
            description: "Archived",
            articleStatus: "archived"
          },
          {
            topicId: id.topicOtherVault,
            vaultId: id.vaultBeta,
            slug: "other-vault",
            title: "Other Vault",
            description: "Other"
          }
        ])
        .pipe(Effect.orDie);
      yield* db
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
            tags: ["practice"]
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
            tags: ["theory"]
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
            tags: ["lines"]
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
            tags: []
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
            tags: ["archive"]
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
            tags: []
          }
        ])
        .pipe(Effect.orDie);
      yield* db
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
            updatedAt: new Date("2026-07-09T11:00:00.000Z")
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
            updatedAt: new Date("2026-07-09T09:00:00.000Z")
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
            updatedAt: new Date("2026-07-09T08:00:00.000Z")
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
            updatedAt: new Date("2026-07-09T07:00:00.000Z")
          }
        ])
        .pipe(Effect.orDie);
    })
  );

  return {
    aliceToken: await issueToken(id.alice),
    bobToken: await issueToken(id.bob),
    malloryToken: await issueToken(id.mallory),
    aliceApiKey
  };
};

const api = async (method: string, path: string, bearer?: string): Promise<ApiResponse> => {
  const headers = new Headers();
  if (bearer !== undefined) {
    headers.set("authorization", `Bearer ${bearer}`);
  }
  const response = await fetch(`${currentState().started.url}/v1${path}`, {
    method,
    headers
  });
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
      total: Number(pagination.total)
    }
  };
};

const itemRecords = (page: PageBody) => page.items.map(asRecord);

describe("read-only HTTP integration", () => {
  beforeAll(async () => {
    state = await buildTestState();
  });

  beforeEach(async () => {
    currentState().clock.set(initialTime);
    await resetDatabase();
    fixture = await seedFixtures();
  });

  afterAll(async () => {
    const current = state;
    state = undefined;
    fixture = undefined;
    if (current !== undefined) {
      await current.started.close();
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
      [id.vaultBeta]: "viewer"
    });

    const withApiKey = await api("GET", "/vaults?limit=1", rawKey);
    expect(withApiKey.status).toBe(200);
    expect(asPage(withApiKey.body).items).toHaveLength(1);

    const zero = await api("GET", "/vaults?limit=0", aliceToken);
    expect(zero.status).toBe(200);
    expect(asPage(zero.body)).toEqual({
      items: [],
      pagination: { limit: 0, offset: 0, total: 2 }
    });

    const cap = await api("GET", "/vaults?limit=200", aliceToken);
    expect(cap.status).toBe(200);
    expect(asPage(cap.body).pagination.limit).toBe(200);

    const pastEnd = await api("GET", "/vaults?offset=99", aliceToken);
    expect(pastEnd.status).toBe(200);
    expect(asPage(pastEnd.body)).toEqual({
      items: [],
      pagination: { limit: 50, offset: 99, total: 2 }
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
      article_count: 5
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
      kinds: ["person", "event", "organization", "concept"]
    });

    const nonMember = await api("GET", `/vaults/${id.vaultAlpha}/config`, malloryToken);
    expect(nonMember.status).toBe(403);
    expect(nonMember.body).toEqual({
      detail: "Only vault members can perform this action"
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
      { user_id: id.bob, email: "bob@example.com", role: "editor" }
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
      detail: "Only vault owners can perform this action"
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
      "gamma-lines"
    ]);
    expect(articles.map((article) => article.file_path)).not.toContain("wiki/_index.md");
    expect(articles.map((article) => article.title)).not.toContain("Archived Essay");

    const byRun = await api("GET", `/vaults/${id.vaultAlpha}/wiki?run=${id.runAlpha}`, aliceToken);
    expect(byRun.status).toBe(200);
    expect(itemRecords(asPage(byRun.body)).map((article) => article.slug)).toEqual([
      "alpha-practice",
      "gamma-lines"
    ]);

    const withApiKey = await api("GET", `/vaults/${id.vaultAlpha}/wiki?limit=1`, rawKey);
    expect(withApiKey.status).toBe(200);
    expect(asPage(withApiKey.body).items).toHaveLength(1);

    const zero = await api("GET", `/vaults/${id.vaultAlpha}/wiki?limit=0`, aliceToken);
    expect(zero.status).toBe(200);
    expect(asPage(zero.body).pagination).toEqual({ limit: 0, offset: 0, total: 3 });
    expect(asPage(zero.body).items).toEqual([]);

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
      "gamma-lines"
    ]);

    const zero = await api("GET", `/vaults/${id.vaultAlpha}/wiki/recent?limit=0`, aliceToken);
    expect(zero.status).toBe(200);
    expect(asPage(zero.body)).toEqual({
      items: [],
      pagination: { limit: 0, offset: 0, total: 3 }
    });

    const cap = await api("GET", `/vaults/${id.vaultAlpha}/wiki/recent?limit=200`, aliceToken);
    expect(cap.status).toBe(200);
    expect(asPage(cap.body).pagination.limit).toBe(200);

    const overCap = await api("GET", `/vaults/${id.vaultAlpha}/wiki/recent?limit=201`, aliceToken);
    expect(overCap.status).toBe(422);

    const nonMember = await api("GET", `/vaults/${id.vaultAlpha}/wiki/recent`, malloryToken);
    expect(nonMember.status).toBe(403);

    const unauthenticated = await api("GET", `/vaults/${id.vaultAlpha}/wiki/recent`);
    expect(unauthenticated.status).toBe(401);
  });

  it("lists raw sources with search, source-type facets, nullability, and authz", async () => {
    const { aliceToken, malloryToken } = currentFixture();
    const listed = await api("GET", `/vaults/${id.vaultAlpha}/raw/sources`, aliceToken);
    expect(listed.status).toBe(200);
    const page = asPage(listed.body);
    const sources = itemRecords(page);
    expect(page.pagination).toEqual({ limit: 50, offset: 0, total: 3 });
    expect(sources.map((source) => source.file_path)).toEqual([
      "raw/books/capital.md",
      "raw/articles/organization.md",
      "raw/speeches/mass-strike.md"
    ]);
    const speech = sources.find(
      (source) => source.file_path === "raw/speeches/mass-strike.md"
    );
    expect(speech).toMatchObject({
      title: null,
      url: null,
      origin: null,
      genre: null,
      tags: [],
      derived_extras: {}
    });
    expect(asRecord(listed.body).facets).toEqual({
      source_types: expect.arrayContaining([
        { value: "book", count: 1 },
        { value: "article", count: 1 },
        { value: "speech", count: 1 }
      ])
    });

    const searched = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/raw/sources?search=Marx`,
      aliceToken
    );
    expect(searched.status).toBe(200);
    expect(itemRecords(asPage(searched.body)).map((source) => source.file_path)).toEqual([
      "raw/books/capital.md"
    ]);
    expect(asPage(searched.body).pagination.total).toBe(1);
    const searchedFacets = asRecord(searched.body).facets as {
      source_types: ReadonlyArray<{ value: string; count: number }>;
    };
    expect(
      [...searchedFacets.source_types].sort((a, b) => a.value.localeCompare(b.value))
    ).toEqual([
      { value: "article", count: 1 },
      { value: "book", count: 1 },
      { value: "speech", count: 1 }
    ]);

    const emptyParams = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/raw/sources?search=&source_type=`,
      aliceToken
    );
    expect(emptyParams.status).toBe(200);
    expect(asPage(emptyParams.body).pagination.total).toBe(3);

    const filtered = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/raw/sources?source_type=article`,
      aliceToken
    );
    expect(filtered.status).toBe(200);
    expect(itemRecords(asPage(filtered.body)).map((source) => source.source_type)).toEqual([
      "article"
    ]);

    const zero = await api("GET", `/vaults/${id.vaultAlpha}/raw/sources?limit=0`, aliceToken);
    expect(zero.status).toBe(200);
    expect(asPage(zero.body)).toEqual({
      items: [],
      pagination: { limit: 0, offset: 0, total: 3 }
    });

    const cap = await api("GET", `/vaults/${id.vaultAlpha}/raw/sources?limit=200`, aliceToken);
    expect(cap.status).toBe(200);
    expect(asPage(cap.body).pagination.limit).toBe(200);

    const pastEnd = await api(
      "GET",
      `/vaults/${id.vaultAlpha}/raw/sources?offset=99`,
      aliceToken
    );
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
