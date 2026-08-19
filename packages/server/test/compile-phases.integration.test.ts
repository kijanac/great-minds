import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backlinks,
  anchors,
  compileCacheEntries,
  Database,
  ideas,
  llmCostEvents,
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

import {
  canonicalizeAssignCacheKey,
  canonicalizeRegistryCacheKey,
  CompilePhases,
  CompilePhasesLive,
  partitionCacheKey,
  renderCacheKey,
  synthesizeCacheKey,
  type ValidatedTopic,
} from "../src/compile-phases.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { DEFAULT_RENDER_MODEL } from "../src/config.ts";
import { ClockLive } from "../src/clock.ts";
import { contentHash, promptContentHash } from "../src/crypto.ts";
import { DrizzleLive } from "../src/db.ts";
import { EmbeddingsService } from "../src/embeddings.ts";
import { LanguageModel, type CompleteInput, type ModelCompletion } from "../src/llm.ts";
import { StructuredLogger } from "../src/logging.ts";
import { PipelineRunsServiceLive } from "../src/pipeline-runs.ts";
import { RandomBytesLive } from "../src/random.ts";
import { ContentStorage, StorageFileMissing } from "../src/storage.ts";

const id = {
  user: "20000000-0000-4000-8000-000000000001" as Uuid,
  vault: "20000000-0000-4000-8000-000000000002" as Uuid,
  run: "20000000-0000-4000-8000-000000000003" as Uuid,
  source: "20000000-0000-4000-8000-000000000004" as Uuid,
  sourceB: "20000000-0000-4000-8000-000000000013" as Uuid,
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
  openRouterApiUrl: "https://example.invalid",
  parallelApiKey: Option.none(),
  parallelSearchUrl: "https://example.invalid",
  queryModel: "test",
  queryFallbackModels: ["test"],
  extractModel: "deepseek/deepseek-v3.2",
  mapModel: "deepseek/deepseek-v3.2",
  reduceModel: "anthropic/claude-sonnet-4.6",
  renderModel: DEFAULT_RENDER_MODEL,
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
  corsOrigins: [],
  suppressAuth: false,
  allowPrivateUrlFetch: false,
  serverHost: "127.0.0.1",
  serverPort: 0,
};

const files = new Map<string, string>();
const etags = new Map<string, string>();
const embeddingRequests: string[][] = [];
const logEvents: { readonly event: string; readonly fields: Record<string, unknown> }[] = [];

const defaultEmbed = async (texts: readonly string[]) => {
  embeddingRequests.push([...texts]);
  return texts.map(() => [1, ...Array.from({ length: 1023 }, () => 0)]);
};
let embed = defaultEmbed;
let complete = async (_input: CompleteInput): Promise<ModelCompletion> => {
  throw new Error("unexpected compile LLM call");
};

const StorageLive = Layer.succeed(ContentStorage, {
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
  clear: () => Effect.void,
});

const ConfigLive = Layer.succeed(AppConfig, config);
const BaseLive = Layer.mergeAll(
  DrizzleLive.pipe(Layer.provideMerge(ConfigLive)),
  ClockLive,
  RandomBytesLive,
);
const PipelineLive = PipelineRunsServiceLive.pipe(Layer.provideMerge(BaseLive));
const EmbeddingsLive = Layer.succeed(EmbeddingsService, {
  embed: (texts) => embed(texts),
});
const LanguageModelLive = Layer.succeed(LanguageModel, {
  hasApiKey: true,
  streamChat: async function* () {},
  complete: (input) => complete(input),
});
const LoggerLive = Layer.succeed(StructuredLogger, {
  info: (event, fields) => Effect.sync(() => logEvents.push({ event, fields })),
  warn: (event, fields) => Effect.sync(() => logEvents.push({ event, fields })),
  error: (event, fields) => Effect.sync(() => logEvents.push({ event, fields })),
});
const PhasesLive = CompilePhasesLive.pipe(
  Layer.provideMerge(LanguageModelLive),
  Layer.provideMerge(EmbeddingsLive),
  Layer.provideMerge(PipelineLive),
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(LoggerLive),
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
      yield* db.query((d) => d.delete(users)).pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(users)
        .values({ id: id.user, email: "phases@example.com" }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(vaults)
        .values({ id: id.vault, name: "Compile Phases", ownerId: id.user }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(pipelineRuns)
        .values({
          id: id.run,
          vaultId: id.vault,
          trigger: "manual",
          status: "pending",
          currentPhase: "",
          phaseStatus: "",
          progressSteps: [],
        }))
        .pipe(Effect.orDie);
    }),
  );

const seedSourceAndIdeas = () =>
  run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d
        .insert(sourceDocuments)
        .values({
          id: id.source,
          vaultId: id.vault,
          filePath: "raw/docs/source.md",
          fileHash: "file",
          bodyHash: "body",
          sourceType: "document",
        }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
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
        ))
        .pipe(Effect.orDie);
    }),
  );

const insertSource = (documentId: Uuid, filePath: string, bodyHash: string) =>
  run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d
        .insert(sourceDocuments)
        .values({
          id: documentId,
          vaultId: id.vault,
          filePath,
          fileHash: `file-${bodyHash}`,
          bodyHash,
          sourceType: "document",
        }))
        .pipe(Effect.orDie);
    }),
  );

const defaultPrompt = async (name: string) =>
  (await readFile(new URL(`../src/default_prompts/${name}.md`, import.meta.url), "utf8")).trim();

const seedCanonicalPath = async (options: {
  readonly registryValue?: unknown;
  readonly assignmentValue?: unknown;
}) => {
  files.set("raw/docs/source.md", "# Source\n\nBody\n");
  await run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d
        .insert(sourceDocuments)
        .values({
          id: id.source,
          vaultId: id.vault,
          filePath: "raw/docs/source.md",
          fileHash: "file",
          bodyHash: "body",
          sourceType: "document",
          title: "Source",
          precis: "Precis",
        }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(ideas)
        .values({
          ideaId: id.ideaA,
          vaultId: id.vault,
          documentId: id.source,
          kind: "concept",
          label: "Idea",
          description: "Description",
          embedding: [1, ...Array.from({ length: 1023 }, () => 0)],
        }))
        .pipe(Effect.orDie);
    }),
  );
  const localTopic = {
    localTopicId: id.topicA,
    chunkIdx: 0,
    slug: "local-topic",
    title: "Canonical Topic",
    description: "Canonical description",
    subsumedIdeaIds: [id.ideaA],
  } as const;
  const synthPromptHash = promptContentHash(await defaultPrompt("synthesize"));
  const registryPromptHash = promptContentHash(await defaultPrompt("canonicalize_registry"));
  const assignPromptHash = promptContentHash(await defaultPrompt("canonicalize_assign"));
  const registryTopic = {
    slug: "canonical-topic",
    title: "Canonical Topic",
    description: "Canonical description",
    link_target_titles: [],
  } as const;
  const registrySignature = contentHash(
    `${registryTopic.slug}|${registryTopic.title}|${registryTopic.description}`,
  );
  const rows: (typeof compileCacheEntries.$inferInsert)[] = [
    {
      vaultId: id.vault,
      phase: "partition",
      cacheKey: partitionCacheKey([id.ideaA], config.compilePartitionTargetTokens),
      value: { chunks: [[id.ideaA]], k_initial: 1, total_tokens: 1 },
    },
    {
      vaultId: id.vault,
      phase: "synthesize",
      cacheKey: synthesizeCacheKey({
        ideaIds: [id.ideaA],
        promptHash: synthPromptHash,
        model: config.mapModel,
      }),
      value: {
        local_topics: [
          {
            local_topic_id: localTopic.localTopicId,
            chunk_idx: localTopic.chunkIdx,
            slug: localTopic.slug,
            title: localTopic.title,
            description: localTopic.description,
            subsumed_idea_ids: [...localTopic.subsumedIdeaIds],
          },
        ],
      },
    },
    {
      vaultId: id.vault,
      phase: "canonicalize_registry",
      cacheKey: canonicalizeRegistryCacheKey({
        orderedTopics: [localTopic],
        promptHash: registryPromptHash,
        thematicHint: "",
        model: config.reduceModel,
      }),
      value: options.registryValue ?? { topics: [registryTopic] },
    },
  ];
  if (options.assignmentValue !== undefined) {
    rows.push({
      vaultId: id.vault,
      phase: "canonicalize_assign",
      cacheKey: canonicalizeAssignCacheKey({
        batch: [localTopic],
        registrySignature,
        promptHash: assignPromptHash,
        model: config.reduceModel,
      }),
      value: options.assignmentValue,
    });
  }
  await run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d.insert(compileCacheEntries).values(rows)).pipe(Effect.orDie);
    }),
  );
  return { localTopic, registryTopic } as const;
};

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
    logEvents.length = 0;
    embed = defaultEmbed;
    complete = async () => {
      throw new Error("unexpected compile LLM call");
    };
    await seedBase();
  });

  it("constructs every compile-cache key with Python length framing", () => {
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

  it("isolates malformed extract output per document and coerces Python-defaulted fields", async () => {
    files.set("raw/docs/bad.md", "# Bad\n\nMALFORMED\n");
    files.set("raw/docs/good.md", "# Good\n\nGOOD\u0085BODY\n");
    await insertSource(id.source, "raw/docs/bad.md", "bad-body");
    await insertSource(id.sourceB, "raw/docs/good.md", "good-body");
    complete = async (input) => {
      const content = input.messages[0]?.content;
      const prompt = typeof content === "string" ? content : "";
      return {
        text: prompt.includes("MALFORMED")
          ? JSON.stringify({ ideas: [null] })
          : JSON.stringify({ ideas: [{ anchors: [{ claim: null, quote: "GOOD BODY" }] }] }),
        finishReason: "stop",
      };
    };

    await run(Effect.flatMap(CompilePhases, (phases) => phases.extract(id.vault, id.run)));

    const extracted = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return {
          ideas: yield* db.query((d) => d.select().from(ideas)).pipe(Effect.orDie),
          anchors: yield* db.query((d) => d.select().from(anchors)).pipe(Effect.orDie),
          docs: yield* db.query((d) => d.select().from(sourceDocuments)).pipe(Effect.orDie),
        };
      }),
    );
    expect(extracted.ideas).toHaveLength(1);
    expect(extracted.ideas[0]).toMatchObject({
      documentId: id.sourceB,
      kind: "other",
      label: "",
      description: "",
    });
    expect(extracted.anchors).toEqual([
      expect.objectContaining({ claim: "", quote: "GOOD BODY", chunkIndex: 0 }),
    ]);
    expect(extracted.docs.find((doc) => doc.id === id.sourceB)).toMatchObject({
      title: "",
      precis: "",
      tags: [],
      derivedExtras: {},
    });
    expect(logEvents).toContainEqual({
      event: "doc_failed",
      fields: expect.objectContaining({
        document_id: id.source,
        error_type: "MalformedLlmOutput",
      }),
    });
  });

  it("marks a malformed extract cache row failed without refetching the LLM", async () => {
    files.set("raw/docs/source.md", "# Source\n\nBody\n");
    await insertSource(id.source, "raw/docs/source.md", "cached-body");
    const template = (await defaultPrompt("extract"))
      .replace("{kinds}", "person, event, organization, concept")
      .replace("{vault_enriched_fields}", "");
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(compileCacheEntries)
          .values({
            vaultId: id.vault,
            phase: "extract",
            cacheKey: contentHash(
              `doc=${id.source}`,
              "cached-body",
              `prompt=${promptContentHash(template)}`,
              `model=${config.extractModel}`,
            ),
            value: { source_card: { title: "drifted" } },
          }))
          .pipe(Effect.orDie);
      }),
    );
    let calls = 0;
    complete = async () => {
      calls += 1;
      return { text: JSON.stringify({ ideas: [] }), finishReason: "stop" };
    };

    await run(Effect.flatMap(CompilePhases, (phases) => phases.extract(id.vault, id.run)));

    expect(calls).toBe(0);
    expect(logEvents).toContainEqual({
      event: "doc_failed",
      fields: expect.objectContaining({ error_type: "MalformedCompileCache" }),
    });
  });

  it("fails extract loudly on a non-timeout embedding error", async () => {
    files.set("raw/docs/source.md", "# Source\n\nBody\n");
    await insertSource(id.source, "raw/docs/source.md", "embedding-body");
    complete = async () => ({
      text: JSON.stringify({
        ideas: [{ kind: "concept", label: "Idea", description: "Description", anchors: [] }],
      }),
      finishReason: "stop",
    });
    embed = async () => {
      throw new Error("revoked credential");
    };

    await expect(
      run(Effect.flatMap(CompilePhases, (phases) => phases.extract(id.vault, id.run))),
    ).rejects.toThrow("revoked credential");
  });

  it("skips only a timed-out embedding batch and logs its real error type", async () => {
    files.set("raw/docs/source.md", "# Source\n\nBody\n");
    await insertSource(id.source, "raw/docs/source.md", "timeout-body");
    complete = async () => ({
      text: JSON.stringify({
        ideas: [{ kind: "concept", label: "Idea", description: "Description", anchors: [] }],
      }),
      finishReason: "stop",
    });
    embed = async () => {
      throw new DOMException("embedding timed out", "TimeoutError");
    };

    await run(Effect.flatMap(CompilePhases, (phases) => phases.extract(id.vault, id.run)));

    const rows = await run(
      Effect.flatMap(Database, (db) => db.query((d) => d.select().from(ideas)).pipe(Effect.orDie)),
    );
    expect(rows).toEqual([]);
    expect(logEvents).toContainEqual({
      event: "embed_batch.timeout",
      fields: expect.objectContaining({
        batch_size: 1,
        error_type: "TimeoutError",
      }),
    });
  });

  it("drops an omitted embedding tail instead of inserting an empty vector", async () => {
    files.set("raw/docs/source.md", "# Source\n\nBody\n");
    await insertSource(id.source, "raw/docs/source.md", "short-embedding-body");
    complete = async () => ({
      text: JSON.stringify({
        ideas: [{ kind: "concept", label: "Idea", description: "Description", anchors: [] }],
      }),
      finishReason: "stop",
    });
    embed = async () => [];

    await run(Effect.flatMap(CompilePhases, (phases) => phases.extract(id.vault, id.run)));

    const rows = await run(
      Effect.flatMap(Database, (db) => db.query((d) => d.select().from(ideas)).pipe(Effect.orDie)),
    );
    expect(rows).toEqual([]);
  });

  it("warns on a JSON parse retry without logging the malformed response", async () => {
    files.set("raw/docs/source.md", "# Source\n\nBody\n");
    await insertSource(id.source, "raw/docs/source.md", "retry-body");
    let attempt = 0;
    complete = async () => {
      attempt += 1;
      return {
        text: attempt === 1 ? "{malformed-secret-shaped-output}" : JSON.stringify({ ideas: [] }),
        finishReason: "stop",
      };
    };

    await run(Effect.flatMap(CompilePhases, (phases) => phases.extract(id.vault, id.run)));

    const retry = logEvents.find((entry) => entry.event === "json_llm_parse_retry");
    expect(retry?.fields).toMatchObject({
      document_id: id.source,
      attempt: 1,
      max_attempts: 2,
      error_type: "SyntaxError",
    });
    expect(JSON.stringify(retry)).not.toContain("malformed-secret-shaped-output");
  });

  it("fails loudly on a malformed canonical registry cache row", async () => {
    await seedCanonicalPath({ registryValue: { topics: "drifted" } });
    await expect(
      run(Effect.flatMap(CompilePhases, (phases) => phases.abstract(id.vault, id.run))),
    ).rejects.toThrow("canonicalize_registry cache row");
  });

  it("fails loudly on a malformed canonical assignment cache row", async () => {
    await seedCanonicalPath({ assignmentValue: { assign: [] } });
    await expect(
      run(Effect.flatMap(CompilePhases, (phases) => phases.abstract(id.vault, id.run))),
    ).rejects.toThrow("canonicalize_assign cache row");
  });

  it("fails loudly when the assignment prompt omits its unique subtopics placeholder", async () => {
    await seedCanonicalPath({});
    files.set("prompts/canonicalize_assign.md", "Registry:\n{registry_block}\nNo batch marker");
    await expect(
      run(Effect.flatMap(CompilePhases, (phases) => phases.abstract(id.vault, id.run))),
    ).rejects.toThrow("must contain exactly one {subtopics_block} placeholder");
  });

  it("rejects a tag suffix unless every character is a decimal digit", async () => {
    const fixture = await seedCanonicalPath({
      assignmentValue: { assign: { [id.topicA]: "canonical-topic" } },
    });
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(topics)
          .values({
            topicId: id.topicB,
            vaultId: id.vault,
            slug: "old-topic",
            title: "Old Topic",
            description: "Old description",
          }))
          .pipe(Effect.orDie);
      }),
    );
    complete = async () => ({
      text: JSON.stringify({
        slug_renames: [{ canonical_tag: "c_1x", new_slug: "mutilated" }],
        supersessions: [],
      }),
      finishReason: "stop",
    });

    const result = await run(
      Effect.flatMap(CompilePhases, (phases) => phases.abstract(id.vault, id.run)),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.slug).toBe(fixture.registryTopic.slug);
  });

  it("fails loudly on a malformed cleanup entry", async () => {
    await seedCanonicalPath({ assignmentValue: { assign: { [id.topicA]: "canonical-topic" } } });
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(topics)
          .values({
            topicId: id.topicB,
            vaultId: id.vault,
            slug: "old-topic",
            title: "Old Topic",
            description: "Old description",
          }))
          .pipe(Effect.orDie);
      }),
    );
    complete = async () => ({
      text: JSON.stringify({ slug_renames: [null], supersessions: [] }),
      finishReason: "stop",
    });

    await expect(
      run(Effect.flatMap(CompilePhases, (phases) => phases.abstract(id.vault, id.run))),
    ).rejects.toThrow("cleanup slug rename is not an object");
  });

  it("ingest indexes path-sorted metadata/body chunks and skips an unchanged ETag replay", async () => {
    const content =
      "---\ntitle: Source title\nprecis: Source precis\nauthor: Author\n---\n# Heading\n\nFirst paragraph ^p0\n\nSecond paragraph ^p1\n";
    files.set("raw/docs/source.md", content);
    etags.set("raw/docs/source.md", "etag-one");
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(sourceDocuments)
          .values({
            id: id.source,
            vaultId: id.vault,
            filePath: "raw/docs/source.md",
            fileHash: "file",
            bodyHash: "body",
            sourceType: "document",
          }))
          .pipe(Effect.orDie);
        const phases = yield* CompilePhases;
        yield* phases.ingest(id.vault, id.run);
      }),
    );
    const rows = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select({
            path: searchIndex.path,
            chunkIndex: searchIndex.chunkIndex,
            heading: searchIndex.heading,
            body: searchIndex.body,
            contentHash: searchIndex.contentHash,
          })
          .from(searchIndex)
          .orderBy(searchIndex.chunkIndex))
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
        yield* db.query((d) => d
          .insert(topics)
          .values(
            validated.map((topic) => ({
              topicId: topic.topicId as Uuid,
              vaultId: id.vault,
              slug: topic.slug,
              title: topic.title,
              description: topic.description,
            })),
          ))
          .pipe(Effect.orDie);
        const phases = yield* CompilePhases;
        yield* phases.derive(id.vault, id.run, validated);
      }),
    );
    const rows = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return {
          membership: yield* db.query((d) => d.select().from(topicMembership)).pipe(Effect.orDie),
          links: yield* db.query((d) => d.select().from(topicLinks)).pipe(Effect.orDie),
          related: yield* db.query((d) => d.select().from(topicRelated)).pipe(Effect.orDie),
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

  it("render repairs a missing file from cache, reuses it, and isolates an invalid-cache fallthrough", async () => {
    await seedSourceAndIdeas();
    const prompt = (
      await readFile(new URL("../src/default_prompts/render.md", import.meta.url), "utf8")
    ).trim();
    const topic = validated[0]!;
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(topics)
          .values({
            topicId: topic.topicId as Uuid,
            vaultId: id.vault,
            slug: topic.slug,
            title: topic.title,
            description: topic.description,
            compiledFromHash: "compiled",
          }))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
          .insert(compileCacheEntries)
          .values({
            vaultId: id.vault,
            phase: "render",
            cacheKey: renderCacheKey({
              topic,
              promptHash: promptContentHash(prompt),
              model: DEFAULT_RENDER_MODEL,
            }),
            value: { body: "# Alpha\n\nCached body.", tags: ["Cached Tag", "cached-tag"] },
          }))
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
        yield* db.query((d) => d
          .insert(topics)
          .values({
            topicId: id.topicC,
            vaultId: id.vault,
            slug: invalid.slug,
            title: invalid.title,
            description: invalid.description,
          }))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
          .insert(compileCacheEntries)
          .values({
            vaultId: id.vault,
            phase: "render",
            cacheKey: renderCacheKey({
              topic: invalid,
              promptHash: promptContentHash(prompt),
              model: DEFAULT_RENDER_MODEL,
            }),
            value: { body: 42, tags: [] },
          }))
          .pipe(Effect.orDie);
      }),
    );
    await run(
      Effect.flatMap(CompilePhases, (phases) => phases.render(id.vault, id.run, [invalid])),
    );
    expect(files.has("wiki/invalid.md")).toBe(false);
    expect(logEvents).toContainEqual({
      event: "topic_failed",
      fields: expect.objectContaining({
        topic_id: id.topicC,
        topic_slug: "invalid",
        error_type: "Error",
      }),
    });
  });

  it("flushes compile LLM cost only after publish completes", async () => {
    await seedSourceAndIdeas();
    const topic = validated[0]!;
    complete = async () => ({
      text: JSON.stringify({ body: "# Alpha\n\nRendered body.", tags: ["alpha"] }),
      finishReason: "stop",
      usage: { cost: 0.125 },
    });
    const counts = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(topics)
          .values({
            topicId: topic.topicId as Uuid,
            vaultId: id.vault,
            slug: topic.slug,
            title: topic.title,
            description: topic.description,
            compiledFromHash: "compiled",
          }))
          .pipe(Effect.orDie);
        const phases = yield* CompilePhases;
        yield* phases.render(id.vault, id.run, [topic]);
        const beforePublish = yield* db.query((d) => d.select().from(llmCostEvents)).pipe(Effect.orDie);
        yield* phases.publish(id.vault, id.run, "2026-07-13T12:00:00+00:00");
        const afterPublish = yield* db.query((d) => d.select().from(llmCostEvents)).pipe(Effect.orDie);
        return { beforePublish, afterPublish };
      }),
    );
    expect(counts.beforePublish).toEqual([]);
    expect(counts.afterPublish).toHaveLength(1);
    expect(counts.afterPublish[0]?.costUsd).toBe("0.125000");
  });

  it("archives rendered and unrendered topics with terminal supersession pointers", async () => {
    await seedSourceAndIdeas();
    files.set("wiki/alpha.md", "---\ntopic_id: old\ntitle: Alpha\n---\n# Alpha\n");
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
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
          ]))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
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
          }))
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
        return yield* db.query((d) => d
          .select({
            id: topics.topicId,
            status: topics.articleStatus,
            successor: topics.supersededBy,
          })
          .from(topics)
          .where(eq(topics.articleStatus, "archived")))
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
        yield* db.query((d) => d
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
          ))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
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
          ]))
          .pipe(Effect.orDie);
        const phases = yield* CompilePhases;
        yield* phases.verify(id.vault, id.run);
        yield* phases.publish(id.vault, id.run, "2026-07-12T12:00:00+00:00");
        yield* phases.publish(id.vault, id.run, "2026-07-12T12:00:00+00:00");
      }),
    );
    const edges = await run(
      Effect.flatMap(Database, (db) => db.query((d) => d.select().from(backlinks)).pipe(Effect.orDie)),
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
