import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backlinks,
  compileCacheEntries,
  Database,
  ideas,
  pipelineRuns,
  searchIndex,
  sourceDocuments,
  topicLinks,
  topicMembership,
  topicRelated,
  topics,
  users,
  vaults,
  wikiArticles,
} from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, Redacted } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { RENDER_MODEL,
  canonicalizeAssignCacheKey,
  canonicalizeRegistryCacheKey,
  CompilePhases,
  CompilePhasesLive,
  extractCacheKey,
  partitionCacheKey,
  renderCacheKey,
  synthesizeCacheKey,
  type ValidatedTopic,
} from "../src/compile-phases.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { contentHash, promptContentHash } from "../src/crypto.ts";
import { DrizzleLive } from "../src/db.ts";
import { EmbeddingsService } from "../src/embeddings.ts";
import { PipelineRunsServiceLive } from "../src/pipeline-runs.ts";
import { StorageFileMissing, VaultStorage } from "../src/storage.ts";

const id = {
  user: "20000000-0000-4000-8000-000000000001" as Uuid,
  vault: "20000000-0000-4000-8000-000000000002" as Uuid,
  run: "20000000-0000-4000-8000-000000000003" as Uuid,
  source: "20000000-0000-4000-8000-000000000004" as Uuid,
  ideaA: "20000000-0000-4000-8000-000000000005" as Uuid,
  ideaB: "20000000-0000-4000-8000-000000000006" as Uuid,
  ideaC: "20000000-0000-4000-8000-000000000007" as Uuid,
  topicA: "20000000-0000-4000-8000-000000000008" as Uuid,
  topicB: "20000000-0000-4000-8000-000000000009" as Uuid,
  topicC: "20000000-0000-4000-8000-000000000010" as Uuid,
  articleA: "20000000-0000-4000-8000-000000000011" as Uuid,
  articleB: "20000000-0000-4000-8000-000000000012" as Uuid,
} as const;

const databaseUrl = () => {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value.length === 0) throw new Error("DATABASE_URL is required");
  return value;
};

const dataDir = await mkdtemp(join(tmpdir(), "gm-compile-phases-"));
const config: AppConfigShape = {
  databaseUrl: Redacted.make(databaseUrl()),
  jwtSecret: Redacted.make("compile-phase-secret"),
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
  openRouterApiUrl: "https://example.invalid",
  parallelApiKey: Option.none(),
  parallelSearchUrl: "https://example.invalid",
  queryModel: "test",
  queryFallbackModels: ["test"],
  extractModel: "deepseek/deepseek-v3.2",
  compileDeriveRelatedLimit: 20,
  embeddingModel: "qwen/qwen3-embedding-8b",
  corsOrigins: [],
  suppressAuth: false,
  serverHost: "127.0.0.1",
  serverPort: 0,
};

const files = new Map<string, string>();
const etags = new Map<string, string>();
const embeddingRequests: string[][] = [];

const StorageLive = Layer.succeed(VaultStorage, {
  listMarkdown: (_vaultId, scope) =>
    Effect.succeed(
      [...files.keys()]
        .filter((path) => path.startsWith(`${scope}/`) && path.endsWith(".md"))
        .filter((path) => scope === "raw" || !path.slice("wiki/".length).includes("/"))
        .sort()
        .map((path) => ({ path, etag: etags.get(path) ?? null })),
    ),
  readText: (_vaultId, path) => {
    const content = files.get(path);
    return content === undefined
      ? Effect.fail(new StorageFileMissing({ path }))
      : Effect.succeed(content);
  },
  writeText: (_vaultId, path, content) =>
    Effect.sync(() => files.set(path, content)).pipe(Effect.asVoid),
  appendText: () => Effect.void,
  exists: (_vaultId, path) => Effect.succeed(files.has(path)),
  deletePath: (_vaultId, path) => Effect.sync(() => files.delete(path)).pipe(Effect.asVoid),
  clearVault: () => Effect.void,
  prepareBucketForOwner: () => Effect.succeed(null),
  deleteOwnerBucket: () => Effect.void,
  presignStagedPut: () => Effect.die("unused"),
  readStagedBytes: () => Effect.die("unused"),
  deleteStaged: () => Effect.die("unused"),
});

const ConfigLive = Layer.succeed(AppConfig, config);
const BaseLive = DrizzleLive.pipe(Layer.provideMerge(ConfigLive));
const PipelineLive = PipelineRunsServiceLive.pipe(Layer.provideMerge(BaseLive));
const EmbeddingsLive = Layer.succeed(EmbeddingsService, {
  embed: async (texts) => {
    embeddingRequests.push([...texts]);
    return texts.map(() => [1, ...Array.from({ length: 1023 }, () => 0)]);
  },
});
const PhasesLive = CompilePhasesLive.pipe(
  Layer.provideMerge(EmbeddingsLive),
  Layer.provideMerge(PipelineLive),
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(BaseLive),
);
const TestLive = PhasesLive.pipe(
  Layer.provideMerge(PipelineLive),
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(BaseLive),
);

const run = <A>(effect: Effect.Effect<A, unknown, Database | CompilePhases>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestLive)));

const seedBase = () =>
  run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.delete(users).pipe(Effect.orDie);
      yield* db
        .insert(users)
        .values({ id: id.user, email: "phases@example.com" })
        .pipe(Effect.orDie);
      yield* db
        .insert(vaults)
        .values({ id: id.vault, name: "Compile Phases", ownerId: id.user })
        .pipe(Effect.orDie);
      yield* db
        .insert(pipelineRuns)
        .values({
          id: id.run,
          vaultId: id.vault,
          trigger: "manual",
          status: "pending",
          currentPhase: "",
          phaseStatus: "",
          progressSteps: [],
        })
        .pipe(Effect.orDie);
    }),
  );

const seedSourceAndIdeas = () =>
  run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db
        .insert(sourceDocuments)
        .values({
          id: id.source,
          vaultId: id.vault,
          filePath: "raw/docs/source.md",
          fileHash: "file",
          bodyHash: "body",
          sourceType: "document",
        })
        .pipe(Effect.orDie);
      yield* db
        .insert(ideas)
        .values(
          [id.ideaA, id.ideaB, id.ideaC].map((ideaId, index) => ({
            ideaId,
            vaultId: id.vault,
            documentId: id.source,
            kind: "claim",
            label: `Idea ${index}`,
            description: `Description ${index}`,
          })),
        )
        .pipe(Effect.orDie);
    }),
  );

const validated: readonly ValidatedTopic[] = [
  {
    topicId: id.topicA,
    slug: "alpha",
    title: "Alpha",
    description: "Alpha description",
    subsumedIdeaIds: [id.ideaA, id.ideaB],
    linkTargets: ["beta"],
  },
  {
    topicId: id.topicB,
    slug: "beta",
    title: "Beta",
    description: "Beta description",
    subsumedIdeaIds: [id.ideaB, id.ideaC],
    linkTargets: ["alpha", "missing", "beta"],
  },
];

describe("M4.3a deterministic compile phases", () => {
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    files.clear();
    etags.clear();
    embeddingRequests.length = 0;
    await seedBase();
  });

  it("constructs every compile-cache key with Python length framing", () => {
    expect(
      extractCacheKey({
        documentId: id.source,
        bodyHash: "body-hash",
        promptHash: "prompt-hash",
        model: "extract-model",
      }),
    ).toBe(
      contentHash(`doc=${id.source}`, "body-hash", "prompt=prompt-hash", "model=extract-model"),
    );
    expect(partitionCacheKey([id.ideaB, id.ideaA], 100_000)).toBe(
      contentHash(id.ideaA, id.ideaB, "target=100000"),
    );
    expect(synthesizeCacheKey({ ideaIds: [id.ideaB, id.ideaA], promptHash: "p", model: "m" })).toBe(
      contentHash(id.ideaA, id.ideaB, "prompt=p", "model=m"),
    );
    const registry = canonicalizeRegistryCacheKey({
      orderedTopics: [{ title: "T", description: "D", subsumedIdeaIds: [id.ideaA, id.ideaB] }],
      promptHash: "p",
      thematicHint: "hint",
      model: "m",
    });
    expect(registry).toBe(
      contentHash(contentHash("T", "D", "2"), "prompt=p", `hint=${contentHash("hint")}`, "model=m"),
    );
    expect(
      canonicalizeAssignCacheKey({
        batch: [{ localTopicId: id.topicA, title: "T", description: "D" }],
        registrySignature: "registry",
        promptHash: "p",
        model: "m",
      }),
    ).toBe(
      contentHash(
        "registry=registry",
        `${id.topicA}:${contentHash("T", "D")}`,
        "prompt=p",
        "model=m",
      ),
    );
  });

  it("ingest indexes path-sorted metadata/body chunks and skips an unchanged ETag replay", async () => {
    const content =
      "---\ntitle: Source title\nprecis: Source precis\nauthor: Author\n---\n# Heading\n\nFirst paragraph ^p0\n\nSecond paragraph ^p1\n";
    files.set("raw/docs/source.md", content);
    etags.set("raw/docs/source.md", "etag-one");
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(sourceDocuments)
          .values({
            id: id.source,
            vaultId: id.vault,
            filePath: "raw/docs/source.md",
            fileHash: "file",
            bodyHash: "body",
            sourceType: "document",
          })
          .pipe(Effect.orDie);
        const phases = yield* CompilePhases;
        yield* phases.ingest(id.vault, id.run);
      }),
    );
    const rows = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db
          .select({
            path: searchIndex.path,
            chunkIndex: searchIndex.chunkIndex,
            heading: searchIndex.heading,
            body: searchIndex.body,
            contentHash: searchIndex.contentHash,
          })
          .from(searchIndex)
          .orderBy(searchIndex.chunkIndex)
          .pipe(Effect.orDie);
      }),
    );
    expect(rows).toEqual([
      {
        path: "raw/docs/source.md",
        chunkIndex: -1,
        heading: "",
        body: "Source title\n\nSource precis\n\nby Author",
        contentHash: contentHash("chunk", "Source title\n\nSource precis\n\nby Author"),
      },
      {
        path: "raw/docs/source.md",
        chunkIndex: 0,
        heading: "Heading",
        body: "Heading\n\nFirst paragraph",
        contentHash: contentHash("chunk", "Heading\n\nFirst paragraph"),
      },
      {
        path: "raw/docs/source.md",
        chunkIndex: 1,
        heading: "Heading",
        body: "Heading\n\nSecond paragraph",
        contentHash: contentHash("chunk", "Heading\n\nSecond paragraph"),
      },
    ]);
    expect(embeddingRequests).toEqual([rows.map((row) => row.body)]);
    embeddingRequests.length = 0;
    await run(Effect.flatMap(CompilePhases, (phases) => phases.ingest(id.vault, id.run)));
    expect(embeddingRequests).toEqual([]);
  });

  it("derive replaces membership, intended links, and deterministic bidirectional Jaccard rows", async () => {
    await seedSourceAndIdeas();
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(topics)
          .values(
            validated.map((topic) => ({
              topicId: topic.topicId as Uuid,
              vaultId: id.vault,
              slug: topic.slug,
              title: topic.title,
              description: topic.description,
            })),
          )
          .pipe(Effect.orDie);
        const phases = yield* CompilePhases;
        yield* phases.derive(id.vault, id.run, validated);
      }),
    );
    const rows = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return {
          membership: yield* db.select().from(topicMembership).pipe(Effect.orDie),
          links: yield* db.select().from(topicLinks).pipe(Effect.orDie),
          related: yield* db.select().from(topicRelated).pipe(Effect.orDie),
        };
      }),
    );
    expect(rows.membership).toHaveLength(4);
    expect(rows.links).toEqual([
      { sourceTopicId: id.topicA, targetTopicId: id.topicB },
      { sourceTopicId: id.topicB, targetTopicId: id.topicA },
    ]);
    expect(rows.related).toEqual([
      { topicId: id.topicA, relatedTopicId: id.topicB, sharedIdeas: 1, jaccard: 1 / 3 },
      { topicId: id.topicB, relatedTopicId: id.topicA, sharedIdeas: 1, jaccard: 1 / 3 },
    ]);
  });

  it("render repairs a missing file from cache, reuses it, and rejects an invalid-cache fallthrough", async () => {
    await seedSourceAndIdeas();
    const prompt = (
      await readFile(new URL("../src/default_prompts/render.md", import.meta.url), "utf8")
    ).trim();
    const topic = validated[0]!;
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(topics)
          .values({
            topicId: topic.topicId as Uuid,
            vaultId: id.vault,
            slug: topic.slug,
            title: topic.title,
            description: topic.description,
            compiledFromHash: "compiled",
          })
          .pipe(Effect.orDie);
        yield* db
          .insert(compileCacheEntries)
          .values({
            vaultId: id.vault,
            phase: "render",
            cacheKey: renderCacheKey({ topic, promptHash: promptContentHash(prompt), model: RENDER_MODEL }),
            value: { body: "# Alpha\n\nCached body.", tags: ["Cached Tag", "cached-tag"] },
          })
          .pipe(Effect.orDie);
        const phases = yield* CompilePhases;
        yield* phases.render(id.vault, id.run, [topic]);
      }),
    );
    expect(files.get("wiki/alpha.md")).toContain("# Alpha\n\nCached body.");
    const requestCount = embeddingRequests.length;
    await run(Effect.flatMap(CompilePhases, (phases) => phases.render(id.vault, id.run, [topic])));
    expect(embeddingRequests).toHaveLength(requestCount);

    const invalid = { ...validated[1]!, topicId: id.topicC, slug: "invalid" };
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(topics)
          .values({
            topicId: id.topicC,
            vaultId: id.vault,
            slug: invalid.slug,
            title: invalid.title,
            description: invalid.description,
          })
          .pipe(Effect.orDie);
        yield* db
          .insert(compileCacheEntries)
          .values({
            vaultId: id.vault,
            phase: "render",
            cacheKey: renderCacheKey({ topic: invalid, promptHash: promptContentHash(prompt), model: RENDER_MODEL }),
            value: { body: 42, tags: [] },
          })
          .pipe(Effect.orDie);
      }),
    );
    await expect(
      run(Effect.flatMap(CompilePhases, (phases) => phases.render(id.vault, id.run, [invalid]))),
    ).rejects.toMatchObject({ _tag: "CompilePhaseNotPorted", phase: "render" });
  });

  it("archives rendered and unrendered topics with terminal supersession pointers", async () => {
    await seedSourceAndIdeas();
    files.set("wiki/alpha.md", "---\ntopic_id: old\ntitle: Alpha\n---\n# Alpha\n");
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(topics)
          .values([
            {
              topicId: id.topicA,
              vaultId: id.vault,
              slug: "alpha",
              title: "Alpha",
              description: "A",
              articleStatus: "rendered",
            },
            {
              topicId: id.topicB,
              vaultId: id.vault,
              slug: "beta",
              title: "Beta",
              description: "B",
            },
            {
              topicId: id.topicC,
              vaultId: id.vault,
              slug: "no-file",
              title: "No File",
              description: "C",
            },
          ])
          .pipe(Effect.orDie);
        yield* db
          .insert(wikiArticles)
          .values({
            id: id.articleA,
            vaultId: id.vault,
            topicId: id.topicA,
            filePath: "wiki/alpha.md",
            fileHash: "file",
            bodyHash: "body",
            title: "Alpha",
            precis: "A",
          })
          .pipe(Effect.orDie);
        const phases = yield* CompilePhases;
        yield* phases.archiveTransitions(id.vault, [
          { topicId: id.topicA, slug: "alpha", supersededBy: id.topicB },
          { topicId: id.topicC, slug: "no-file", supersededBy: null },
        ]);
      }),
    );
    expect(files.has("wiki/alpha.md")).toBe(false);
    expect(files.get(`archive/${id.topicA}/alpha.md`)).toContain(`superseded_by: ${id.topicB}`);
    const archived = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db
          .select({
            id: topics.topicId,
            status: topics.articleStatus,
            successor: topics.supersededBy,
          })
          .from(topics)
          .where(eq(topics.articleStatus, "archived"))
          .pipe(Effect.orDie);
      }),
    );
    expect(archived).toEqual(
      expect.arrayContaining([
        { id: id.topicA, status: "archived", successor: id.topicB },
        { id: id.topicC, status: "archived", successor: null },
      ]),
    );
  });

  it("verify replaces prose backlinks and publish writes exact live indexes plus the local compile log", async () => {
    await seedSourceAndIdeas();
    files.set(
      "wiki/alpha.md",
      "# Alpha\n\nSee [Beta](wiki/beta.md), [Beta again](wiki/beta.md), [missing](wiki/missing.md), and [self](wiki/alpha.md).\n",
    );
    files.set("wiki/beta.md", "# Beta\n");
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .insert(topics)
          .values(
            validated.map((topic) => ({
              topicId: topic.topicId as Uuid,
              vaultId: id.vault,
              slug: topic.slug,
              title: topic.title,
              description: topic.description,
              articleStatus: "rendered",
              compiledFromHash: "same",
              renderedFromHash: "same",
            })),
          )
          .pipe(Effect.orDie);
        yield* db
          .insert(wikiArticles)
          .values([
            {
              id: id.articleA,
              vaultId: id.vault,
              topicId: id.topicA,
              filePath: "wiki/alpha.md",
              fileHash: "a",
              bodyHash: "a",
              title: "Alpha",
              precis: "Alpha description",
            },
            {
              id: id.articleB,
              vaultId: id.vault,
              topicId: id.topicB,
              filePath: "wiki/beta.md",
              fileHash: "b",
              bodyHash: "b",
              title: "Beta",
              precis: "Beta description",
            },
          ])
          .pipe(Effect.orDie);
        const phases = yield* CompilePhases;
        yield* phases.verify(id.vault, id.run);
        yield* phases.publish(id.vault, id.run, "2026-07-12T12:00:00+00:00");
        yield* phases.publish(id.vault, id.run, "2026-07-12T12:00:00+00:00");
      }),
    );
    const edges = await run(
      Effect.flatMap(Database, (db) => db.select().from(backlinks).pipe(Effect.orDie)),
    );
    expect(edges).toEqual([{ sourceArticleId: id.articleA, targetArticleId: id.articleB }]);
    expect(files.get("wiki/_index.md")).toBe(
      "# Wiki Index\n\n_2 rendered articles_\n\n- [Alpha](wiki/alpha.md) — Alpha description\n- [Beta](wiki/beta.md) — Beta description\n",
    );
    expect(files.get("raw/_index.md")).toContain("[raw/docs/source.md](raw/docs/source.md)");
    const log = await readFile(join(dataDir, ".compile", id.vault, "log.md"), "utf8");
    expect(log).toContain("- topics: 2 (rendered 2, archived 0, dirty 0)");
    expect(log.match(/## 2026-07-12T12:00:00\+00:00/g)).toHaveLength(1);
  });
});
