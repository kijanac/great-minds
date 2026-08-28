import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server as NodeServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  Database,
  sessions,
  shares,
  userDocuments,
  users,
  vaultMemberships,
  vaults,
} from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeAppLayer } from "../src/app-layer.ts";
import { ClockService, makeTestClock } from "../src/clock.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { StructuredLogger, StructuredLoggerLive } from "../src/logging.ts";
import { makeTestMailer } from "../src/mailer.ts";
import { makeTestRandomBytes } from "../src/random.ts";
import { startServer } from "../src/server.ts";
import { SessionsService } from "../src/sessions.ts";
import { TokenService } from "../src/tokens.ts";

const initialTime = new Date("2026-07-10T12:00:00.000Z");

const id = {
  alice: "00000000-0000-4000-8000-000000010001",
  bob: "00000000-0000-4000-8000-000000010002",
  vault: "00000000-0000-4000-8000-000000010101",
} as const;

type TestServices =
  | AppConfig
  | Database
  | ClockService
  | SessionsService
  | StructuredLogger
  | TokenService;

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
};

type ApiResponse = {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
  readonly headers: Headers;
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
  const storageRoot = await mkdtemp(join(tmpdir(), "great-minds-shares-storage-"));
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
      yield* db.query((d) => d.delete(users)).pipe(Effect.orDie);
    }),
  );

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
        ]))
        .pipe(Effect.orDie);
    }),
  );
  return {
    aliceToken: await issueToken(id.alice),
    bobToken: await issueToken(id.bob),
  };
};

const api = async (
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
  const response = await fetch(`${currentState().started.url}/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? undefined : (JSON.parse(text) as unknown),
    text,
    headers: response.headers,
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

const writeVaultFile = async (vaultId: string, path: string, content: string) => {
  const fullPath = join(currentState().storageRoot, "vaults", vaultId, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
};

const jsonl = (events: readonly unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n");

const createSession = (idempotencyKey: string, query: string, answer: string) =>
  runDb(
    Effect.gen(function* () {
      const sessions = yield* SessionsService;
      return yield* sessions.createSession(id.alice as Uuid, id.vault as Uuid, {
        idempotencyKey,
        exchange: { id: `ex-${idempotencyKey}`, query, thinking: [], answer },
      });
    }),
  );

describe("share links", () => {
  beforeAll(async () => {
    state = await buildTestState();
  });

  beforeEach(async () => {
    const current = currentState();
    current.clock.set(initialTime);
    current.random.reset();
    current.mailer.sent.length = 0;
    await resetDatabase();
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

  it("creates a session share and resolves it to the rendered session without auth", async () => {
    const { aliceToken } = currentFixture();
    const sessionId = await createSession("share-session-key", "Share me?", "Shared answer.");

    const share = await api("POST", "/shares", aliceToken, {
      subject_kind: "session",
      subject_id: sessionId,
    });
    expect(share.status).toBe(201);
    const shareBody = asRecord(share.body);
    expect(shareBody.created).toBe(true);
    const createdShare = asRecord(shareBody.share);
    expect(createdShare).toMatchObject({
      subject_kind: "session",
      subject_id: sessionId,
      created_by: id.alice,
      include_annotations: true,
      expires_at: null,
      revoked_at: null,
    });
    const token = String(createdShare.token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const listed = await api("GET", "/shares", aliceToken);
    expect(listed.status).toBe(200);
    const listedItems = listed.body as ReadonlyArray<Record<string, unknown>>;
    expect(listedItems).toHaveLength(1);
    expect(listedItems[0]).toMatchObject({ id: createdShare.id, token });

    const resolved = await api("GET", `/public/shares/${token}`);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({
      subject_kind: "session",
      title: "Share me?",
      markdown: "# Share me?\n\nShared answer.\n",
      created_at: initialTime.toISOString(),
    });
    expect(resolved.headers.get("x-robots-tag")).toBe("noindex");
    expect(resolved.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("creates a reference share and resolves title, origin, and markdown", async () => {
    const { aliceToken } = currentFixture();
    await withLocalHttpServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<html><head><title>Shared Article</title><meta name=\"author\" content=\"Ada Lovelace\"><meta property=\"article:published_time\" content=\"2024-03-01\"></head><body><article><p>First shared paragraph.</p><p>Second shared paragraph.</p></article></body></html>",
        );
      },
      async (origin) => {
        const reference = await api("POST", "/me/refs", aliceToken, {
          url: `${origin}/article`,
        });
        expect(reference.status).toBe(201);
        const referenceId = String(asRecord(reference.body).id);

        const annotated = await api("POST", "/shares", aliceToken, {
          subject_kind: "reference",
          subject_id: referenceId,
          include_annotations: true,
        });
        expect(annotated.status).toBe(201);
        expect(asRecord(annotated.body).created).toBe(true);
        const annotatedShare = asRecord(asRecord(annotated.body).share);
        expect(annotatedShare).toMatchObject({
          subject_kind: "reference",
          subject_id: referenceId,
          include_annotations: true,
        });
        const annotatedResolved = await api(
          "GET",
          `/public/shares/${String(annotatedShare.token)}`,
        );
        expect(annotatedResolved.status).toBe(200);
        expect(annotatedResolved.body).toMatchObject({
          subject_kind: "reference",
          title: "Shared Article",
          origin: new URL(origin).host,
          author: "Ada Lovelace",
          published: "2024-03-01",
        });
        const annotatedMarkdown = String(asRecord(annotatedResolved.body).markdown);
        expect(annotatedMarkdown).toContain("First shared paragraph. ^p0");
        expect(annotatedMarkdown).toContain("Second shared paragraph. ^p1");

        const referenceRows = await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            return yield* db.query((d) => d
              .select()
              .from(userDocuments)
              .where(eq(userDocuments.id, referenceId)))
              .pipe(Effect.orDie);
          }),
        );
        expect(referenceRows).toHaveLength(1);
        expect(asRecord(annotatedResolved.body).created_at).toBe(
          referenceRows[0]!.createdAt.toISOString(),
        );

        // Flag omitted at create defaults to include_annotations: true, so
        // this reuses the annotated share instead of flipping it off.
        const plain = await api("POST", "/shares", aliceToken, {
          subject_kind: "reference",
          subject_id: referenceId,
        });
        expect(plain.status).toBe(201);
        expect(asRecord(plain.body).created).toBe(false);
        const plainShare = asRecord(asRecord(plain.body).share);
        expect(plainShare.token).toBe(annotatedShare.token);
        expect(plainShare.include_annotations).toBe(true);
        const plainResolved = await api(
          "GET",
          `/public/shares/${String(plainShare.token)}`,
        );
        expect(plainResolved.status).toBe(200);
        const plainMarkdown = String(asRecord(plainResolved.body).markdown);
        expect(plainMarkdown).toContain("First shared paragraph. ^p0");
        expect(asRecord(plainResolved.body).annotations).toEqual([]);

        // An explicit false flips the flag and strips the anchors.
        const stripped = await api("POST", "/shares", aliceToken, {
          subject_kind: "reference",
          subject_id: referenceId,
          include_annotations: false,
        });
        expect(stripped.status).toBe(201);
        expect(asRecord(stripped.body).created).toBe(false);
        const strippedShare = asRecord(asRecord(stripped.body).share);
        expect(strippedShare.token).toBe(annotatedShare.token);
        expect(strippedShare.include_annotations).toBe(false);
        const strippedResolved = await api(
          "GET",
          `/public/shares/${String(strippedShare.token)}`,
        );
        expect(strippedResolved.status).toBe(200);
        const strippedMarkdown = String(asRecord(strippedResolved.body).markdown);
        expect(strippedMarkdown).toContain("First shared paragraph.");
        expect(strippedMarkdown).not.toMatch(/\^p\d/);
      },
    );
  });

  it("reflects reference renames in share resolution", async () => {
    const { aliceToken } = currentFixture();
    await withLocalHttpServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<html><head><title>Renameable Share</title></head><body><article><p>First renameable paragraph.</p><p>Second renameable paragraph.</p></article></body></html>",
        );
      },
      async (origin) => {
        const reference = await api("POST", "/me/refs", aliceToken, {
          url: `${origin}/article`,
        });
        expect(reference.status).toBe(201);
        const referenceId = String(asRecord(reference.body).id);

        const share = await api("POST", "/shares", aliceToken, {
          subject_kind: "reference",
          subject_id: referenceId,
        });
        expect(share.status).toBe(201);
        const token = String(asRecord(asRecord(share.body).share).token);

        const before = await api("GET", `/public/shares/${token}`);
        expect(before.status).toBe(200);
        expect(asRecord(before.body).title).toBe("Renameable Share");

        const renamed = await api(
          "PATCH",
          "/me/refs/refs/article.md",
          aliceToken,
          { title: "Renamed Share Title" },
        );
        expect(renamed.status).toBe(200);

        const after = await api("GET", `/public/shares/${token}`);
        expect(after.status).toBe(200);
        expect(asRecord(after.body)).toMatchObject({
          subject_kind: "reference",
          title: "Renamed Share Title",
          origin: new URL(origin).host,
        });

        const cleared = await api(
          "PATCH",
          "/me/refs/refs/article.md",
          aliceToken,
          { title: "  " },
        );
        expect(cleared.status).toBe(200);
        const clearedResolve = await api("GET", `/public/shares/${token}`);
        expect(clearedResolve.status).toBe(200);
        expect(asRecord(clearedResolve.body).title).toBeNull();
      },
    );
  });

  it("resolves reference shares with anchored annotation threads when include_annotations is true", async () => {
    const { aliceToken } = currentFixture();
    await withLocalHttpServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<html><head><title>Annotated Article</title></head><body><article><p>Annotated first paragraph with enough words to extract.</p><p>Annotated second paragraph.</p></article></body></html>",
        );
      },
      async (origin) => {
        const reference = await api("POST", "/me/refs", aliceToken, {
          url: `${origin}/article`,
        });
        expect(reference.status).toBe(201);
        const referenceId = String(asRecord(reference.body).id);

        await runDb(
          Effect.gen(function* () {
            const db = yield* Database;
            yield* db.query((d) => d
              .insert(sessions)
              .values({
                id: "s-annotated",
                vaultId: id.vault,
                userId: id.alice,
                query: "What does the quote mean?",
                origin: {
                  doc_path: "refs/article.md",
                  origin_scope: "personal",
                  anchor: "Annotated first paragraph with enough words to extract.",
                  paragraph: "Annotated first paragraph with enough words to extract.",
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
          "sessions/s-annotated.jsonl",
          jsonl([
            {
              type: "meta",
              id: "s-annotated",
              query: "What does the quote mean?",
              ts: "2026-07-11T09:00:00.000Z",
              user_id: id.alice,
              origin: {
                doc_path: "refs/article.md",
                origin_scope: "personal",
                anchor: "Annotated first paragraph with enough words to extract.",
                paragraph: "Annotated first paragraph with enough words to extract.",
                paragraph_index: 0,
              },
            },
            {
              type: "exchange",
              exId: "ex-ann-1",
              query: "What does the quote mean?",
              thinking: [
                {
                  sources: [
                    {
                      label: "secret source",
                      type: "raw",
                      document_id: null,
                      title: null,
                      scope: null,
                      path: null,
                      thinking: "internal reasoning",
                    },
                  ],
                },
              ],
              answer: "The quote anchors the first claim.",
              ts: "2026-07-11T09:05:00.000Z",
            },
            {
              type: "exchange",
              exId: "ex-ann-2",
              query: "How should organizers use it?",
              thinking: [],
              answer: "Use it to open the discussion.",
              ts: "2026-07-11T09:06:00.000Z",
            },
          ]),
        );

        // Flag omitted at create defaults to include_annotations: true.
        const share = await api("POST", "/shares", aliceToken, {
          subject_kind: "reference",
          subject_id: referenceId,
        });
        expect(share.status).toBe(201);
        expect(asRecord(asRecord(share.body).share)).toMatchObject({
          include_annotations: true,
        });
        const token = String(asRecord(asRecord(share.body).share).token);

        const resolved = await api("GET", `/public/shares/${token}`);
        expect(resolved.status).toBe(200);
        expect(asRecord(resolved.body).annotations).toEqual([
          {
            anchor: {
              quote: "Annotated first paragraph with enough words to extract.",
              context: "Annotated first paragraph with enough words to extract.",
              block_offset: 0,
            },
            exchanges: [
              {
                query: "What does the quote mean?",
                answer: "The quote anchors the first claim.",
              },
              {
                query: "How should organizers use it?",
                answer: "Use it to open the discussion.",
              },
            ],
            created_at: "2026-07-11T09:00:00.000Z",
          },
        ]);
        // Thinking blocks and sources are stripped from shared annotations.
        const resolvedJson = JSON.stringify(resolved.body);
        expect(resolvedJson).not.toContain("secret source");
        expect(resolvedJson).not.toContain("internal reasoning");

        // Explicit false hides the annotations and strips the anchors.
        const plain = await api("POST", "/shares", aliceToken, {
          subject_kind: "reference",
          subject_id: referenceId,
          include_annotations: false,
        });
        expect(plain.status).toBe(201);
        expect(asRecord(plain.body).created).toBe(false);
        expect(asRecord(asRecord(plain.body).share).include_annotations).toBe(false);
        const plainResolved = await api(
          "GET",
          `/public/shares/${String(asRecord(asRecord(plain.body).share).token)}`,
        );
        expect(plainResolved.status).toBe(200);
        expect(asRecord(plainResolved.body).annotations).toEqual([]);

        // Flag omitted again flips back to the include_annotations: true default.
        const again = await api("POST", "/shares", aliceToken, {
          subject_kind: "reference",
          subject_id: referenceId,
        });
        expect(again.status).toBe(201);
        expect(asRecord(asRecord(again.body).share).include_annotations).toBe(true);
        const againResolved = await api(
          "GET",
          `/public/shares/${String(asRecord(asRecord(again.body).share).token)}`,
        );
        expect(asRecord(againResolved.body).annotations).toHaveLength(1);
      },
    );
  });

  it("returns the identical 404 for unknown, revoked, and expired tokens", async () => {
    const { aliceToken } = currentFixture();
    const sessionId = await createSession("share-404-key", "Gone?", "Vanished.");

    const revokedShare = await api("POST", "/shares", aliceToken, {
      subject_kind: "session",
      subject_id: sessionId,
    });
    const revokedId = String(asRecord(asRecord(revokedShare.body).share).id);
    const revokedToken = String(asRecord(asRecord(revokedShare.body).share).token);
    const revoked = await api("DELETE", `/shares/${revokedId}`, aliceToken);
    expect(revoked.status).toBe(204);

    const expiredShare = await api("POST", "/shares", aliceToken, {
      subject_kind: "session",
      subject_id: sessionId,
      expires_at: "2020-01-01T00:00:00.000Z",
    });
    const expiredToken = String(asRecord(asRecord(expiredShare.body).share).token);

    const unknown = await api("GET", "/public/shares/not-a-real-token");
    const revokedResolved = await api("GET", `/public/shares/${revokedToken}`);
    const expiredResolved = await api("GET", `/public/shares/${expiredToken}`);
    expect(unknown.status).toBe(404);
    expect(revokedResolved.status).toBe(404);
    expect(expiredResolved.status).toBe(404);
    expect(revokedResolved.body).toEqual({ detail: "Share not found" });
    expect(expiredResolved.body).toEqual({ detail: "Share not found" });
    expect(unknown.body).toEqual(revokedResolved.body);
    expect(unknown.body).toEqual(expiredResolved.body);
  });

  it("stores the plaintext token in the database", async () => {
    const { aliceToken } = currentFixture();
    const sessionId = await createSession("share-token-key", "Token me?", "Token.");
    const share = await api("POST", "/shares", aliceToken, {
      subject_kind: "session",
      subject_id: sessionId,
    });
    const token = String(asRecord(asRecord(share.body).share).token);

    const rows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d.select().from(shares)).pipe(Effect.orDie);
      }),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.token).toBe(token);
    expect(row.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(row)).toContain(token);
  });

  it("returns the same token when a share already exists for the subject", async () => {
    const { aliceToken } = currentFixture();
    const subjectId = await createSession("share-once-key", "Once?", "Once.");

    const first = await api("POST", "/shares", aliceToken, {
      subject_kind: "session",
      subject_id: subjectId,
    });
    expect(first.status).toBe(201);
    expect(asRecord(first.body).created).toBe(true);
    const firstToken = String(asRecord(asRecord(first.body).share).token);

    const second = await api("POST", "/shares", aliceToken, {
      subject_kind: "session",
      subject_id: subjectId,
    });
    expect(second.status).toBe(201);
    expect(asRecord(second.body).created).toBe(false);
    expect(String(asRecord(asRecord(second.body).share).token)).toBe(firstToken);

    const rows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d.select().from(shares)).pipe(Effect.orDie);
      }),
    );
    expect(rows).toHaveLength(1);
  });

  it("mints a fresh token after revoke and create", async () => {
    const { aliceToken } = currentFixture();
    const subjectId = await createSession("share-rotate-key", "Rotate?", "Rotate.");

    const first = await api("POST", "/shares", aliceToken, {
      subject_kind: "session",
      subject_id: subjectId,
    });
    const firstShare = asRecord(asRecord(first.body).share);
    const firstToken = String(firstShare.token);
    const revoked = await api("DELETE", `/shares/${String(firstShare.id)}`, aliceToken);
    expect(revoked.status).toBe(204);

    const second = await api("POST", "/shares", aliceToken, {
      subject_kind: "session",
      subject_id: subjectId,
    });
    expect(second.status).toBe(201);
    expect(asRecord(second.body).created).toBe(true);
    const secondToken = String(asRecord(asRecord(second.body).share).token);
    expect(secondToken).not.toBe(firstToken);
    expect(secondToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects API-key authentication on share creation", async () => {
    const { aliceToken } = currentFixture();
    const keyCreate = await api("POST", "/auth/api-keys", aliceToken, {
      label: "share-test",
    });
    expect(keyCreate.status).toBe(201);
    const rawKey = String(asRecord(keyCreate.body).raw_key);

    const sessionId = await createSession("share-apikey-key", "Keyed?", "Denied.");
    const rejected = await api("POST", "/shares", rawKey, {
      subject_kind: "session",
      subject_id: sessionId,
    });
    expect(rejected.status).toBe(403);
    expect(rejected.body).toEqual({
      detail: "Share creation requires session authentication",
    });
  });

  it("lets only the owner revoke a share", async () => {
    const { aliceToken, bobToken } = currentFixture();
    const sessionId = await createSession("share-revoke-key", "Revoke?", "Later.");
    const share = await api("POST", "/shares", aliceToken, {
      subject_kind: "session",
      subject_id: sessionId,
    });
    const shareId = String(asRecord(asRecord(share.body).share).id);

    const nonOwner = await api("DELETE", `/shares/${shareId}`, bobToken);
    expect(nonOwner.status).toBe(404);
    expect(nonOwner.body).toEqual({ detail: "Share not found" });

    const missing = await api("DELETE", "/shares/00000000-0000-4000-8000-000000019999", aliceToken);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ detail: "Share not found" });

    const owner = await api("DELETE", `/shares/${shareId}`, aliceToken);
    expect(owner.status).toBe(204);
    const rows = await runDb(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select({ revokedAt: shares.revokedAt })
          .from(shares)
          .where(eq(shares.id, shareId)))
          .pipe(Effect.orDie);
      }),
    );
    expect(rows[0]?.revokedAt).not.toBeNull();
  });
});
