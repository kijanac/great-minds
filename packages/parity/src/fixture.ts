import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import * as PgClient from "@effect/sql-pg/PgClient";
import {
  apiKeys,
  authCodes,
  backlinks,
  Database,
  ideas,
  DatabaseLive,
  pipelineRuns,
  refreshTokens,
  searchIndex,
  sessions,
  sourceDocuments,
  sourceProposals,
  topicMembership,
  topics,
  users,
  vaultMemberships,
  vaults,
  wikiArticles,
} from "@great-minds/database";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";

export const ids = {
  alice: "00000000-0000-4000-8000-000000000001",
  bob: "00000000-0000-4000-8000-000000000002",
  carol: "00000000-0000-4000-8000-000000000003",
  mallory: "00000000-0000-4000-8000-000000000004",
  doraZeroMember: "00000000-0000-4000-8000-000000000005",
  vaultAlpha: "00000000-0000-4000-8000-000000000101",
  vaultBeta: "00000000-0000-4000-8000-000000000102",
  unknownVault: "00000000-0000-4000-8000-000000000199",
  runAlpha: "00000000-0000-4000-8000-000000000201",
  topicAlpha: "00000000-0000-4000-8000-000000000301",
  topicBeta: "00000000-0000-4000-8000-000000000302",
  topicGamma: "00000000-0000-4000-8000-000000000303",
  topicIndex: "00000000-0000-4000-8000-000000000304",
  topicArchived: "00000000-0000-4000-8000-000000000305",
  topicArchivedLone: "00000000-0000-4000-8000-000000000306",
  topicOtherVault: "00000000-0000-4000-8000-000000000307",
  articleAlpha: "00000000-0000-4000-8000-000000000401",
  articleBeta: "00000000-0000-4000-8000-000000000402",
  articleGamma: "00000000-0000-4000-8000-000000000403",
  articleIndex: "00000000-0000-4000-8000-000000000404",
  articleArchived: "00000000-0000-4000-8000-000000000405",
  articleArchivedLone: "00000000-0000-4000-8000-000000000406",
  articleOtherVault: "00000000-0000-4000-8000-000000000407",
  sourceBook: "00000000-0000-4000-8000-000000000501",
  sourceArticle: "00000000-0000-4000-8000-000000000502",
  sourceSpeech: "00000000-0000-4000-8000-000000000503",
  sourceEncoded: "00000000-0000-4000-8000-000000000504",
  sourceOtherVault: "00000000-0000-4000-8000-000000000505",
  apiKeyAliceActive: "00000000-0000-4000-8000-000000000601",
  apiKeyAliceRevoked: "00000000-0000-4000-8000-000000000602",
  apiKeyBobActive: "00000000-0000-4000-8000-000000000603",
  apiKeyBobRevoked: "00000000-0000-4000-8000-000000000604",
  authCodeExpired: "00000000-0000-4000-8000-000000000611",
  authCodeUsed: "00000000-0000-4000-8000-000000000612",
  refreshActive: "00000000-0000-4000-8000-000000000621",
  refreshRevoked: "00000000-0000-4000-8000-000000000622",
  mutationSurvivor: "00000000-0000-4000-8000-000000000631",
  mutationSurvivorVault: "00000000-0000-4000-8000-000000000632",
  mutationSurvivorMembership: "00000000-0000-4000-8000-000000000633",
  sessionAliceOlder: "s-1",
  sessionAliceMain: "s-2",
  sessionBob: "s-bob",
  sessionNoMarkdown: "s-no-md",
  sessionMalformed: "s-malformed",
  sessionMultiMeta: "s-multi-meta",
  sessionNonObject: "s-non-object",
  m31Proposal: "00000000-0000-4000-8000-000000001201",
  m31SourceDeleteB: "00000000-0000-4000-8000-000000001212",
  m31TopicDeleteB: "00000000-0000-4000-8000-000000001222",
  m31IdeaDeleteB: "00000000-0000-4000-8000-000000001232",
  m32ClientHashA: "00000000-0000-4000-8000-000000001301",
  m32ClientHashB: "00000000-0000-4000-8000-000000001302",
  m32StagedRun: "00000000-0000-4000-8000-000000001311",
  m32StagedEmptyRun: "00000000-0000-4000-8000-000000001312",
  m32UrlRun: "00000000-0000-4000-8000-000000001313",
  m32UrlFailRun: "00000000-0000-4000-8000-000000001314",
} as const;

export const rawKeys = {
  aliceActive: "gm_alice_read_key",
  aliceRevoked: "gm_alice_revoked_key",
  bobActive: "gm_bob_read_key",
  bobRevoked: "gm_bob_revoked_key",
  seededRefreshActive: "seed-refresh-active",
  seededRefreshRevoked: "seed-refresh-revoked",
} as const;

export type FixtureIds = typeof ids;

type DbRuntime = ManagedRuntime.ManagedRuntime<Database, unknown>;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const databaseRuntime = (databaseUrl: string): DbRuntime => {
  const pg = PgClient.layer({ url: Redacted.make(databaseUrl) });
  return ManagedRuntime.make(DatabaseLive.pipe(Layer.provide(pg)));
};

const runDb = <A>(runtime: DbRuntime, effect: Effect.Effect<A, unknown, Database>) =>
  runtime.runPromise(effect);

export const resetDatabase = async (databaseUrl: string) => {
  const runtime = databaseRuntime(databaseUrl);
  try {
    await runDb(
      runtime,
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.execute(sql`delete from absurd.r_default`).pipe(Effect.orDie);
        yield* db.execute(sql`delete from absurd.t_default`).pipe(Effect.orDie);
        yield* db.delete(authCodes).pipe(Effect.orDie);
        yield* db.delete(users).pipe(Effect.orDie);
      }),
    );
  } finally {
    await runtime.dispose();
  }
};

export const seedDuplicateClientHashSources = async (
  databaseUrl: string,
  vaultId: string,
  clientHash: string,
) => {
  const runtime = databaseRuntime(databaseUrl);
  try {
    await runDb(
      runtime,
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(sourceDocuments)
          .values([
            {
              id: ids.m32ClientHashA,
              vaultId,
              filePath: "raw/docs/parity-dupe-a.md",
              fileHash: "parity-dupe-file-a",
              bodyHash: "parity-dupe-body-a",
              clientHash,
              sourceType: "document",
              tags: [],
              derivedExtras: {},
              updatedAt: new Date("2026-07-08T00:00:00.000Z"),
            },
            {
              id: ids.m32ClientHashB,
              vaultId,
              filePath: "raw/docs/parity-dupe-b.md",
              fileHash: "parity-dupe-file-b",
              bodyHash: "parity-dupe-body-b",
              clientHash,
              sourceType: "document",
              tags: [],
              derivedExtras: {},
              updatedAt: new Date("2026-07-08T00:01:00.000Z"),
            },
          ])
          .pipe(Effect.orDie);
      }),
    );
  } finally {
    await runtime.dispose();
  }
};

export const resetStorage = async (dataDir: string) => {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
};

export const seedDeletionCompanionVault = async (databaseUrl: string, deletingUserEmail: string) => {
  const runtime = databaseRuntime(databaseUrl);
  try {
    await runDb(
      runtime,
      Effect.gen(function* () {
        const db = yield* Database;
        const deletingUsers = yield* db
          .select()
          .from(users)
          .where(eq(users.email, deletingUserEmail))
          .limit(1)
          .pipe(Effect.orDie);
        const deletingUser = deletingUsers[0];
        if (deletingUser === undefined) {
          return yield* Effect.die(new Error(`missing deleting user ${deletingUserEmail}`));
        }
        yield* db
          .insert(users)
          .values({
            id: ids.mutationSurvivor,
            email: "mutation-survivor@example.com",
            createdAt: new Date("2026-07-09T12:00:00.000Z"),
          })
          .pipe(Effect.orDie);
        yield* db
          .insert(vaults)
          .values({
            id: ids.mutationSurvivorVault,
            name: "Survivor Vault",
            ownerId: ids.mutationSurvivor,
            createdAt: new Date("2026-07-09T12:01:00.000Z"),
          })
          .pipe(Effect.orDie);
        yield* db
          .insert(vaultMemberships)
          .values([
            {
              id: ids.mutationSurvivorMembership,
              vaultId: ids.mutationSurvivorVault,
              userId: deletingUser.id,
              role: "VIEWER",
              createdAt: new Date("2026-07-09T12:02:00.000Z"),
            },
            {
              id: "00000000-0000-4000-8000-000000000634",
              vaultId: ids.mutationSurvivorVault,
              userId: ids.mutationSurvivor,
              role: "OWNER",
              createdAt: new Date("2026-07-09T12:01:00.000Z"),
            },
          ])
          .pipe(Effect.orDie);
      }),
    );
  } finally {
    await runtime.dispose();
  }
};

const writeVaultFile = async (dataDir: string, vaultId: string, path: string, content: string) => {
  const fullPath = join(dataDir, "vaults", vaultId, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
};

const writeProposalFile = async (dataDir: string, proposalId: string, content: string) => {
  const fullPath = join(dataDir, "proposals", `${proposalId}.md`);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
};

const jsonl = (events: readonly unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

const chunkId = (index: number) =>
  `00000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`;

export const seedReadFixture = async (databaseUrl: string, dataDir: string) => {
  const runtime = databaseRuntime(databaseUrl);
  try {
    await runDb(
      runtime,
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(users)
          .values([
            {
              id: ids.alice,
              email: "alice@example.com",
              createdAt: new Date("2026-07-01T00:00:00.000Z"),
            },
            {
              id: ids.bob,
              email: "bob@example.com",
              createdAt: new Date("2026-07-01T00:01:00.000Z"),
            },
            {
              id: ids.carol,
              email: "carol@example.com",
              createdAt: new Date("2026-07-01T00:02:00.000Z"),
            },
            {
              id: ids.mallory,
              email: "mallory@example.com",
              createdAt: new Date("2026-07-01T00:03:00.000Z"),
            },
            {
              id: ids.doraZeroMember,
              email: "dora@example.com",
              createdAt: new Date("2026-07-01T00:04:00.000Z"),
            },
          ])
          .pipe(Effect.orDie);
        yield* db
          .insert(authCodes)
          .values([
            {
              id: ids.authCodeExpired,
              email: "alice@example.com",
              codeHash: hash("111111"),
              expiresAt: new Date("2026-07-01T00:00:00.000Z"),
              used: false,
              createdAt: new Date("2026-07-01T00:00:00.000Z"),
            },
            {
              id: ids.authCodeUsed,
              email: "alice@example.com",
              codeHash: hash("222222"),
              expiresAt: new Date("2026-07-20T00:00:00.000Z"),
              used: true,
              createdAt: new Date("2026-07-01T00:01:00.000Z"),
            },
          ])
          .pipe(Effect.orDie);
        yield* db
          .insert(vaults)
          .values([
            {
              id: ids.vaultAlpha,
              name: "Alpha Vault",
              ownerId: ids.alice,
              createdAt: new Date("2026-07-02T00:00:00.000Z"),
            },
            {
              id: ids.vaultBeta,
              name: "Beta Vault",
              ownerId: ids.bob,
              createdAt: new Date("2026-07-03T00:00:00.000Z"),
              r2BucketName: "beta-bucket",
            },
          ])
          .pipe(Effect.orDie);
        yield* db
          .insert(vaultMemberships)
          .values([
            {
              id: "00000000-0000-4000-8000-000000000701",
              vaultId: ids.vaultAlpha,
              userId: ids.alice,
              role: "OWNER",
              createdAt: new Date("2026-07-02T00:00:00.000Z"),
            },
            {
              id: "00000000-0000-4000-8000-000000000702",
              vaultId: ids.vaultAlpha,
              userId: ids.bob,
              role: "EDITOR",
              createdAt: new Date("2026-07-02T00:01:00.000Z"),
            },
            {
              id: "00000000-0000-4000-8000-000000000703",
              vaultId: ids.vaultAlpha,
              userId: ids.carol,
              role: "VIEWER",
              createdAt: new Date("2026-07-02T00:02:00.000Z"),
            },
            {
              id: "00000000-0000-4000-8000-000000000704",
              vaultId: ids.vaultBeta,
              userId: ids.bob,
              role: "OWNER",
              createdAt: new Date("2026-07-03T00:00:00.000Z"),
            },
            {
              id: "00000000-0000-4000-8000-000000000705",
              vaultId: ids.vaultBeta,
              userId: ids.alice,
              role: "VIEWER",
              createdAt: new Date("2026-07-03T00:01:00.000Z"),
            },
            {
              id: "00000000-0000-4000-8000-000000000706",
              vaultId: ids.vaultBeta,
              userId: ids.mallory,
              role: "VIEWER",
              createdAt: new Date("2026-07-03T00:02:00.000Z"),
            },
          ])
          .pipe(Effect.orDie);
        yield* db
          .insert(apiKeys)
          .values([
            {
              id: ids.apiKeyAliceActive,
              userId: ids.alice,
              keyHash: hash(rawKeys.aliceActive),
              label: "read automation",
              revoked: false,
              createdAt: new Date("2026-07-04T01:00:00.000Z"),
            },
            {
              id: ids.apiKeyAliceRevoked,
              userId: ids.alice,
              keyHash: hash(rawKeys.aliceRevoked),
              label: "old automation",
              revoked: true,
              createdAt: new Date("2026-07-04T00:00:00.000Z"),
            },
            {
              id: ids.apiKeyBobActive,
              userId: ids.bob,
              keyHash: hash(rawKeys.bobActive),
              label: "bob automation",
              revoked: false,
              createdAt: new Date("2026-07-04T01:30:00.000Z"),
            },
            {
              id: ids.apiKeyBobRevoked,
              userId: ids.bob,
              keyHash: hash(rawKeys.bobRevoked),
              label: "bob old automation",
              revoked: true,
              createdAt: new Date("2026-07-04T00:30:00.000Z"),
            },
          ])
          .pipe(Effect.orDie);
        yield* db
          .insert(refreshTokens)
          .values([
            {
              id: ids.refreshActive,
              userId: ids.alice,
              tokenHash: hash(rawKeys.seededRefreshActive),
              expiresAt: new Date("2026-07-20T00:00:00.000Z"),
              revoked: false,
              createdAt: new Date("2026-07-04T02:00:00.000Z"),
            },
            {
              id: ids.refreshRevoked,
              userId: ids.alice,
              tokenHash: hash(rawKeys.seededRefreshRevoked),
              expiresAt: new Date("2026-07-20T00:00:00.000Z"),
              revoked: true,
              createdAt: new Date("2026-07-04T02:30:00.000Z"),
            },
          ])
          .pipe(Effect.orDie);
        yield* db
          .insert(pipelineRuns)
          .values({
            id: ids.runAlpha,
            vaultId: ids.vaultAlpha,
            trigger: "parity",
            status: "completed",
            currentPhase: "render",
            phaseStatus: "completed",
            progressSteps: [],
            createdAt: new Date("2026-07-05T00:00:00.000Z"),
            updatedAt: new Date("2026-07-05T01:00:00.000Z"),
          })
          .pipe(Effect.orDie);
        yield* db
          .insert(topics)
          .values([
            {
              topicId: ids.topicAlpha,
              vaultId: ids.vaultAlpha,
              slug: "alpha-practice",
              title: "alpha Practice",
              description: "Alpha",
              articleStatus: "rendered",
            },
            {
              topicId: ids.topicBeta,
              vaultId: ids.vaultAlpha,
              slug: "beta-theory",
              title: "Beta Theory",
              description: "Beta",
              articleStatus: "rendered",
            },
            {
              topicId: ids.topicGamma,
              vaultId: ids.vaultAlpha,
              slug: "gamma-lines",
              title: "gamma Lines",
              description: "Gamma",
              articleStatus: "rendered",
            },
            {
              topicId: ids.topicIndex,
              vaultId: ids.vaultAlpha,
              slug: "_index",
              title: "Index",
              description: "Index",
              articleStatus: "rendered",
            },
            {
              topicId: ids.topicArchived,
              vaultId: ids.vaultAlpha,
              slug: "archived-essay",
              title: "Archived Essay",
              description: "Archived",
              articleStatus: "archived",
              supersededBy: ids.topicBeta,
            },
            {
              topicId: ids.topicArchivedLone,
              vaultId: ids.vaultAlpha,
              slug: "archived-lone",
              title: "Archived Lone",
              description: "Archived no successor",
              articleStatus: "archived",
            },
            {
              topicId: ids.topicOtherVault,
              vaultId: ids.vaultBeta,
              slug: "other-vault",
              title: "Other Vault",
              description: "Other",
              articleStatus: "rendered",
            },
          ])
          .pipe(Effect.orDie);
        yield* db
          .insert(wikiArticles)
          .values([
            {
              id: ids.articleAlpha,
              vaultId: ids.vaultAlpha,
              topicId: ids.topicAlpha,
              filePath: "wiki/alpha-practice.md",
              fileHash: "hash-alpha",
              bodyHash: "body-alpha",
              title: "alpha Practice",
              precis: "Alpha precis",
              updatedAt: new Date("2026-07-09T10:00:00.000Z"),
              renderRunId: ids.runAlpha,
              tags: ["practice"],
            },
            {
              id: ids.articleBeta,
              vaultId: ids.vaultAlpha,
              topicId: ids.topicBeta,
              filePath: "wiki/beta-theory.md",
              fileHash: "hash-beta",
              bodyHash: "body-beta",
              title: "Beta Theory",
              precis: "Beta precis",
              updatedAt: new Date("2026-07-09T12:00:00.000Z"),
              tags: ["theory"],
            },
            {
              id: ids.articleGamma,
              vaultId: ids.vaultAlpha,
              topicId: ids.topicGamma,
              filePath: "wiki/gamma-lines.md",
              fileHash: "hash-gamma",
              bodyHash: "body-gamma",
              title: "gamma Lines",
              precis: "Gamma precis",
              updatedAt: new Date("2026-07-08T12:00:00.000Z"),
              renderRunId: ids.runAlpha,
              tags: ["lines"],
            },
            {
              id: ids.articleIndex,
              vaultId: ids.vaultAlpha,
              topicId: ids.topicIndex,
              filePath: "wiki/_index.md",
              fileHash: "hash-index",
              bodyHash: "body-index",
              title: "Index",
              precis: "Index precis",
              updatedAt: new Date("2026-07-10T12:00:00.000Z"),
              tags: [],
            },
            {
              id: ids.articleArchived,
              vaultId: ids.vaultAlpha,
              topicId: ids.topicArchived,
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
              id: ids.articleArchivedLone,
              vaultId: ids.vaultAlpha,
              topicId: ids.topicArchivedLone,
              filePath: "archive/archived-lone.md",
              fileHash: "hash-archived-lone",
              bodyHash: "body-archived-lone",
              title: "Archived Lone",
              precis: "Archived lone precis",
              updatedAt: new Date("2026-07-11T13:00:00.000Z"),
              archived: true,
              tags: ["archive"],
            },
            {
              id: ids.articleOtherVault,
              vaultId: ids.vaultBeta,
              topicId: ids.topicOtherVault,
              filePath: "wiki/other-vault.md",
              fileHash: "hash-other",
              bodyHash: "body-other",
              title: "Other Vault",
              precis: "Other precis",
              updatedAt: new Date("2026-07-09T13:00:00.000Z"),
              tags: [],
            },
          ])
          .pipe(Effect.orDie);
        yield* db
          .insert(sourceDocuments)
          .values([
            {
              id: ids.sourceBook,
              vaultId: ids.vaultAlpha,
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
              id: ids.sourceArticle,
              vaultId: ids.vaultAlpha,
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
              id: ids.sourceSpeech,
              vaultId: ids.vaultAlpha,
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
              id: ids.sourceEncoded,
              vaultId: ids.vaultAlpha,
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
              id: ids.sourceOtherVault,
              vaultId: ids.vaultBeta,
              filePath: "raw/books/capital.md",
              fileHash: "source-hash-beta",
              bodyHash: "source-body-beta",
              sourceType: "book",
              title: "Beta Source",
              author: "Other Author",
              tags: [],
              derivedExtras: {},
              updatedAt: new Date("2026-07-09T07:00:00.000Z"),
            },
          ])
          .pipe(Effect.orDie);
        yield* db
          .insert(backlinks)
          .values([
            {
              sourceArticleId: ids.articleAlpha,
              targetArticleId: ids.articleBeta,
            },
            {
              sourceArticleId: ids.articleGamma,
              targetArticleId: ids.articleAlpha,
            },
            {
              sourceArticleId: ids.articleAlpha,
              targetArticleId: ids.articleArchived,
            },
            {
              sourceArticleId: ids.articleArchived,
              targetArticleId: ids.articleAlpha,
            },
          ])
          .pipe(Effect.orDie);
        yield* db
          .insert(searchIndex)
          .values(
            Array.from({ length: 106 }, (_, offset) => {
              const index = offset - 1;
              const body = index === -1 ? "Synthetic metadata row" : `Capital chunk ${index}`;
              return {
                id: chunkId(offset),
                vaultId: ids.vaultAlpha,
                path: "raw/books/capital.md",
                chunkIndex: index,
                heading: index === -1 ? "Metadata" : index < 2 ? "Opening" : "Later",
                body,
                contentHash: `chunk-hash-${index}`,
                tsv: sql`to_tsvector('english', ${body})`,
              };
            }),
          )
          .pipe(Effect.orDie);
        yield* db
          .insert(sessions)
          .values([
            {
              id: ids.sessionAliceOlder,
              vaultId: ids.vaultAlpha,
              userId: ids.alice,
              query: "Earlier organizing question",
              origin: null,
              createdAt: new Date("2026-07-06T08:00:00.000Z"),
              updatedAt: new Date("2026-07-06T08:05:00.000Z"),
            },
            {
              id: ids.sessionAliceMain,
              vaultId: ids.vaultAlpha,
              userId: ids.alice,
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
              id: ids.sessionBob,
              vaultId: ids.vaultAlpha,
              userId: ids.bob,
              query: "What should editors review first?",
              origin: { doc_path: "raw/books/capital.md" },
              createdAt: new Date("2026-07-08T10:00:00.000Z"),
              updatedAt: new Date("2026-07-08T10:15:00.000Z"),
              idempotencyKey: "bob-main-key",
            },
            {
              id: ids.sessionNoMarkdown,
              vaultId: ids.vaultAlpha,
              userId: ids.alice,
              query: "Missing markdown sidecar",
              origin: null,
              createdAt: new Date("2026-07-09T10:00:00.000Z"),
              updatedAt: new Date("2026-07-09T10:00:00.000Z"),
            },
            {
              id: ids.sessionMalformed,
              vaultId: ids.vaultAlpha,
              userId: ids.alice,
              query: "Malformed event handling",
              origin: null,
              createdAt: new Date("2026-07-09T11:00:00.000Z"),
              updatedAt: new Date("2026-07-09T11:04:00.000Z"),
            },
            {
              id: ids.sessionMultiMeta,
              vaultId: ids.vaultAlpha,
              userId: ids.alice,
              query: "Current multi-meta question",
              origin: null,
              createdAt: new Date("2026-07-09T11:20:00.000Z"),
              updatedAt: new Date("2026-07-09T11:21:00.000Z"),
            },
            {
              id: ids.sessionNonObject,
              vaultId: ids.vaultAlpha,
              userId: ids.alice,
              query: "Non-object event handling",
              origin: null,
              createdAt: new Date("2026-07-09T11:30:00.000Z"),
              updatedAt: new Date("2026-07-09T11:31:00.000Z"),
            },
            {
              id: ids.sessionAliceMain,
              vaultId: ids.vaultBeta,
              userId: ids.bob,
              query: "Beta vault duplicate session id",
              origin: null,
              createdAt: new Date("2026-07-09T12:00:00.000Z"),
              updatedAt: new Date("2026-07-09T12:01:00.000Z"),
            },
          ])
          .pipe(Effect.orDie);
      }),
    );
  } finally {
    await runtime.dispose();
  }

  await writeVaultFile(
    dataDir,
    ids.vaultAlpha,
    "config.yaml",
    "thematic_hint: Prefer movement-level topics.\nkinds:\n  - movement\n  - debate\nweb_search: false\n",
  );
  await writeVaultFile(
    dataDir,
    ids.vaultAlpha,
    "wiki/alpha-practice.md",
    "---\ntitle: alpha Practice\n---\n# Alpha Practice\n\nAlpha body.",
  );
  await writeVaultFile(
    dataDir,
    ids.vaultAlpha,
    "wiki/beta-theory.md",
    "---\ntitle: Beta Theory\n---\n# Beta Theory\n\nBeta body.",
  );
  await writeVaultFile(
    dataDir,
    ids.vaultAlpha,
    "wiki/gamma-lines.md",
    "---\ntitle: gamma Lines\n---\n# Gamma Lines\n\nGamma body.",
  );
  await writeVaultFile(
    dataDir,
    ids.vaultAlpha,
    "archive/archived-essay.md",
    "---\ntitle: Archived Essay\n---\n# Archived Essay\n\nArchived body.",
  );
  await writeVaultFile(
    dataDir,
    ids.vaultAlpha,
    "archive/archived-lone.md",
    "---\ntitle: Archived Lone\n---\n# Archived Lone\n\nArchived lone body.",
  );
  await writeVaultFile(
    dataDir,
    ids.vaultAlpha,
    "wiki/orphan-on-disk.md",
    "---\ntitle: Orphan\n---\n# Orphan\n\nNo registry row.",
  );
  await writeVaultFile(
    dataDir,
    ids.vaultAlpha,
    "raw/books/capital.md",
    "---\ntitle: Capital Volume\n---\n# Capital\n\nCapital body.",
  );
  await writeVaultFile(
    dataDir,
    ids.vaultAlpha,
    "raw/books/encoded title.md",
    "---\ntitle: Encoded Title\n---\nEncoded path body.",
  );
  await writeVaultFile(
    dataDir,
    ids.vaultBeta,
    "wiki/other-vault.md",
    "---\ntitle: Other Vault\n---\n# Other Vault\n\nOther body.",
  );
  await writeVaultFile(
    dataDir,
    ids.vaultBeta,
    "raw/books/capital.md",
    "---\ntitle: Beta Source\n---\n# Beta Source\n\nBeta source body.",
  );
  await writeSessionFiles(dataDir);
};

export const seedNormalProposal = async (
  databaseUrl: string,
  dataDir: string,
  vaultId: string,
  userId: string,
) => {
  const rendered = "---\nsource_type: user_suggestion\n---\nParity proposed source.\n";
  await writeProposalFile(dataDir, ids.m31Proposal, rendered);
  const runtime = databaseRuntime(databaseUrl);
  try {
    await runDb(
      runtime,
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(sourceProposals)
          .values({
            id: ids.m31Proposal,
            vaultId,
            userId,
            status: "PENDING",
            contentType: "user_suggestion",
            title: "Parity Proposal",
            author: "Parity Editor",
            destPath: "raw/user_suggestions/parity-proposal.md",
          })
          .pipe(Effect.orDie);
      }),
    );
  } finally {
    await runtime.dispose();
  }
  return ids.m31Proposal;
};

export const seedSourceDeletionFixture = async (
  databaseUrl: string,
  dataDir: string,
  vaultId: string,
) => {
  const filePath = "raw/books/parity-delete-b.md";
  await writeVaultFile(
    dataDir,
    vaultId,
    filePath,
    "---\nsource_type: book\ntitle: Parity Delete\n---\nDelete body.\n",
  );
  const runtime = databaseRuntime(databaseUrl);
  try {
    await runDb(
      runtime,
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(sourceDocuments)
          .values({
            id: ids.m31SourceDeleteB,
            vaultId,
            filePath,
            fileHash: "file-B",
            bodyHash: "body-B",
            sourceType: "book",
            title: "Parity Delete B",
            tags: [],
            derivedExtras: {},
          })
          .pipe(Effect.orDie);
        yield* db
          .insert(topics)
          .values({
            topicId: ids.m31TopicDeleteB,
            vaultId,
            slug: "parity-delete-b",
            title: "Parity Delete B",
            description: "Delete fixture",
          })
          .pipe(Effect.orDie);
        yield* db
          .insert(ideas)
          .values({
            ideaId: ids.m31IdeaDeleteB,
            vaultId,
            documentId: ids.m31SourceDeleteB,
            kind: "concept",
            label: "delete-B",
            description: "Delete fixture idea",
          })
          .pipe(Effect.orDie);
        yield* db
          .insert(topicMembership)
          .values({ topicId: ids.m31TopicDeleteB, ideaId: ids.m31IdeaDeleteB })
          .pipe(Effect.orDie);
        yield* db
          .insert(searchIndex)
          .values({
            vaultId,
            path: filePath,
            chunkIndex: 0,
            heading: "Delete",
            body: "Delete body",
            contentHash: "chunk-B",
            tsv: sql`to_tsvector('english', 'Delete body')`,
          })
          .pipe(Effect.orDie);
      }),
    );
  } finally {
    await runtime.dispose();
  }
  return filePath;
};

const writeSessionFiles = async (dataDir: string) => {
  await writeVaultFile(
    dataDir,
    ids.vaultAlpha,
    `sessions/${ids.sessionAliceOlder}.jsonl`,
    jsonl([
      {
        type: "meta",
        id: ids.sessionAliceOlder,
        query: "Earlier organizing question",
        ts: "2026-07-06T08:00:00.000Z",
        user_id: ids.alice,
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
    dataDir,
    ids.vaultAlpha,
    `sessions/${ids.sessionAliceMain}.jsonl`,
    jsonl([
      {
        type: "meta",
        id: ids.sessionAliceMain,
        query: "How should study circles use source material?",
        ts: "2026-07-07T09:00:00.000Z",
        user_id: ids.alice,
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
                thinking: "Use the article as a shared reference point.",
                ranges: [{ start: 0, end: 2 }],
                full: false,
              },
              {
                label: "Capital Volume",
                type: "raw",
                thinking: "Raw source grounds the discussion.",
                ranges: [{ start: 3, end: 4 }],
                full: true,
              },
              { label: "Search: pedagogy", type: "search", thinking: null },
              {
                label: "Prior query",
                type: "query",
                thinking: "Compare against previous framing.",
              },
              {
                label: "Linked articles",
                type: "links",
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
            thinking: [{ sources: [{ label: "Linked articles", type: "links", thinking: null }] }],
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
    dataDir,
    ids.vaultAlpha,
    `sessions/${ids.sessionAliceMain}.md`,
    "# Stored Session Markdown\n\nThis came from the sidecar.\n",
  );
  await writeVaultFile(
    dataDir,
    ids.vaultAlpha,
    `sessions/${ids.sessionBob}.jsonl`,
    jsonl([
      {
        type: "meta",
        id: ids.sessionBob,
        query: "What should editors review first?",
        ts: "2026-07-08T10:00:00.000Z",
        user_id: ids.bob,
        origin: { doc_path: "raw/books/capital.md" },
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
    dataDir,
    ids.vaultAlpha,
    `sessions/${ids.sessionNoMarkdown}.jsonl`,
    jsonl([
      {
        type: "meta",
        id: ids.sessionNoMarkdown,
        query: "Missing markdown sidecar",
        ts: "2026-07-09T10:00:00.000Z",
        user_id: ids.alice,
        origin: null,
      },
    ]),
  );
  await writeVaultFile(
    dataDir,
    ids.vaultAlpha,
    `sessions/${ids.sessionMultiMeta}.jsonl`,
    jsonl([
      {
        type: "meta",
        id: ids.sessionMultiMeta,
        query: "Stale multi-meta question",
        ts: "2026-07-01T08:00:00.000Z",
        user_id: ids.alice,
        origin: null,
      },
      {
        type: "exchange",
        exId: "ex-stale",
        query: "Stale multi-meta question",
        thinking: [],
        answer: "This belongs to an older client-reused id.",
        ts: "2026-07-01T08:01:00.000Z",
      },
      {
        type: "meta",
        id: ids.sessionMultiMeta,
        query: "Current multi-meta question",
        ts: "2026-07-09T11:20:00.000Z",
        user_id: ids.alice,
        origin: null,
      },
      {
        type: "exchange",
        exId: "ex-current",
        query: "Current multi-meta question",
        thinking: [],
        answer: "This is the current session content.",
        ts: "2026-07-09T11:21:00.000Z",
      },
    ]),
  );
  await writeVaultFile(
    dataDir,
    ids.vaultAlpha,
    `sessions/${ids.sessionMalformed}.jsonl`,
    `${jsonl([
      {
        type: "meta",
        id: ids.sessionMalformed,
        query: "Malformed event handling",
        ts: "2026-07-09T11:00:00.000Z",
        user_id: ids.alice,
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
  await writeVaultFile(
    dataDir,
    ids.vaultAlpha,
    `sessions/${ids.sessionNonObject}.jsonl`,
    `${jsonl([
      {
        type: "meta",
        id: ids.sessionNonObject,
        query: "Non-object event handling",
        ts: "2026-07-09T11:30:00.000Z",
        user_id: ids.alice,
        origin: null,
      },
      "not an object",
      {
        type: "exchange",
        exId: "ex-after-non-object",
        query: "Does TS skip non-object lines?",
        thinking: [],
        answer: "TS skips JSON values that are not objects.",
        ts: "2026-07-09T11:31:00.000Z",
      },
    ])}\n`,
  );
  await writeVaultFile(
    dataDir,
    ids.vaultBeta,
    `sessions/${ids.sessionAliceMain}.jsonl`,
    jsonl([
      {
        type: "meta",
        id: ids.sessionAliceMain,
        query: "Beta vault duplicate session id",
        ts: "2026-07-09T12:00:00.000Z",
        user_id: ids.bob,
        origin: null,
      },
      {
        type: "exchange",
        exId: "ex-beta",
        query: "Beta vault duplicate session id",
        thinking: [],
        answer: "This proves session files are vault scoped.",
        ts: "2026-07-09T12:01:00.000Z",
      },
    ]),
  );
};
