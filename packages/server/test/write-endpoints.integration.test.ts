import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { StructuredLogger, StructuredLoggerLive } from "../src/logging.ts";
import { makeTestMailer } from "../src/mailer.ts";
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
} as const;

type TestServices = AppConfig | Database | ClockService | StructuredLogger | TokenService;

type TestState = {
  readonly started: Awaited<ReturnType<typeof startServer>>;
  readonly clock: ReturnType<typeof makeTestClock>;
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
  corsOrigins: ["http://localhost:5173"],
  suppressAuth: false,
  serverHost: "127.0.0.1",
  serverPort: 0,
});

const buildTestState = async () => {
  const clock = makeTestClock(initialTime);
  const mailer = makeTestMailer();
  const storageRoot = await mkdtemp(join(tmpdir(), "great-minds-write-storage-"));
  const configLayer = Layer.succeed(AppConfig, testConfig(databaseUrl(), storageRoot));
  const appLayer = makeAppLayer({
    config: configLayer,
    clock: clock.layer,
    mailer: mailer.layer,
    logger: StructuredLoggerLive,
  });
  const started = await startServer({ layer: appLayer, host: "127.0.0.1", port: 0 });
  return { started, clock, mailer, storageRoot } satisfies TestState;
};

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
          { id: "00000000-0000-4000-8000-000000012001", vaultId: id.vault, userId: id.alice, role: "OWNER" },
          { id: "00000000-0000-4000-8000-000000012002", vaultId: id.vault, userId: id.bob, role: "EDITOR" },
          { id: "00000000-0000-4000-8000-000000012003", vaultId: id.vault, userId: id.carol, role: "VIEWER" },
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
  };
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

    const approved = await api(
      "PATCH",
      `/vaults/${id.vault}/proposals/${proposalId}`,
      aliceToken,
      { status: "approved" },
    );
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
    const rejected = await api(
      "PATCH",
      `/vaults/${id.vault}/proposals/${rejectId}`,
      aliceToken,
      { status: "rejected" },
    );
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
          .values({ id: id.task, vaultId: id.vault, type: "compile", params: {}, pipelineRunId: id.run })
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
