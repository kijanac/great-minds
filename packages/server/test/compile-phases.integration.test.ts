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
  prompts,
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
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, Option, Redacted } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalizeAssignCacheKey,
  canonicalizeRegistryCacheKey,
  partitionCacheKey,
  renderCacheKey,
  synthesizeCacheKey,
  type ValidatedTopic,
} from "../src/compile-contract.ts";
import { CompilePhases, CompilePhasesLive } from "../src/compile-phases.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { DEFAULT_RENDER_MODEL } from "../src/config.ts";
import { ClockLive } from "../src/clock.ts";
import {
  bodyContentHash,
  contentHash,
  fileContentHash,
  promptContentHash,
} from "../src/crypto.ts";
import { DrizzleLive } from "../src/db.ts";
import { EmbeddingsService } from "../src/embeddings.ts";
import { LanguageModel, type CompleteInput, type ModelCompletion } from "../src/llm.ts";
import { StructuredLogger } from "../src/logging.ts";
import { parseFrontmatter } from "../src/markdown.ts";
import { PipelineRunsServiceLive } from "../src/pipeline-runs.ts";
import { RandomBytesLive } from "../src/random.ts";
import { SourceDocumentsServiceLive } from "../src/source-documents.ts";
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
  r2BucketName: Option.none(),
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
const SourceDocumentsLive = SourceDocumentsServiceLive.pipe(
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(BaseLive),
);
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
  Layer.provideMerge(SourceDocumentsLive),
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

const insertSource = (
  documentId: Uuid,
  filePath: string,
  bodyHash: string,
  canonicalUrl: string | null = null,
) =>
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
          canonicalUrl,
        }))
        .pipe(Effect.orDie);
    }),
  );

const defaultPrompt = async (name: string) =>
  (await readFile(new URL(`../src/default_prompts/${name}.md`, import.meta.url), "utf8")).trim();

const combinedSynthesizePromptHash = async () =>
  contentHash(
    `synthesize=${promptContentHash(await defaultPrompt("synthesize"))}`,
    `revise=${promptContentHash(await defaultPrompt("synthesize_revise"))}`,
    `decompose=${promptContentHash(await defaultPrompt("synthesize_decompose"))}`,
  );

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
  const synthPromptHash = await combinedSynthesizePromptHash();
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

const fullCard = (ideas: readonly unknown[]) => ({
  title: "",
  precis: "",
  author: null,
  published_date: null,
  genre: null,
  tags: [],
  derived_extras: {},
  ideas,
});

  it("records per-call extract provenance, prompt content, and the embedding model", async () => {
    const canonicalUrl = "https://example.com/source";
    files.set(
      "raw/docs/source.md",
      `---\nsource_id: ${id.source}\ncanonical_url: ${canonicalUrl}\n---\n# Source\n\nBody\n`,
    );
    await insertSource(id.source, "raw/docs/source.md", "provenance-body", canonicalUrl);
    complete = async () => ({
      text: JSON.stringify(
        fullCard([{ kind: "concept", label: "Idea", description: "Description", anchors: [] }]),
      ),
      finishReason: "stop",
      generationId: "extract-generation",
      usage: { promptTokens: 17, completionTokens: 9, cost: 0.125 },
    });

    await run(Effect.flatMap(CompilePhases, (phases) => phases.extract(id.vault, id.run)));

    const template = (await defaultPrompt("extract"))
      .replace("{kinds}", "person, event, organization, concept")
      .replace("{vault_enriched_fields}", "");
    const promptHash = promptContentHash(template);
    const recorded = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return {
          events: yield* db.query((d) => d.select().from(llmCostEvents)).pipe(Effect.orDie),
          prompts: yield* db.query((d) =>
            d.select().from(prompts).where(eq(prompts.hash, promptHash))).pipe(Effect.orDie),
          ideas: yield* db.query((d) => d.select().from(ideas)).pipe(Effect.orDie),
        };
      }),
    );

    expect(recorded.events).toEqual([
      expect.objectContaining({
        vaultId: id.vault,
        eventType: "compile",
        phase: "extract",
        model: config.extractModel,
        promptHash,
        runId: id.run,
        correlationId: `compile-${id.run}`,
        promptTokens: 17,
        completionTokens: 9,
        costUsd: "0.125000",
        generationId: "extract-generation",
      }),
    ]);
    expect(recorded.prompts).toEqual([
      expect.objectContaining({ hash: promptHash, content: template }),
    ]);
    expect(promptContentHash(recorded.prompts[0]!.content)).toBe(recorded.prompts[0]!.hash);
    expect(recorded.ideas).toEqual([
      expect.objectContaining({ embeddingModel: config.embeddingModel }),
    ]);
    expect(parseFrontmatter(files.get("raw/docs/source.md") ?? "").frontmatter).toMatchObject({
      source_id: id.source,
      canonical_url: canonicalUrl,
    });
  });

  it("isolates malformed extract output per document under the strict contract", async () => {
    files.set("raw/docs/bad.md", "# Bad\n\nMALFORMED\n");
    files.set("raw/docs/good.md", "# Good\n\nGOOD\u0085BODY\n");
    await insertSource(id.source, "raw/docs/bad.md", "bad-body");
    await insertSource(id.sourceB, "raw/docs/good.md", "good-body");
    complete = async (input) => {
      const content = input.messages[0]?.content;
      const prompt = typeof content === "string" ? content : "";
      return {
        text: prompt.includes("MALFORMED")
          ? JSON.stringify(fullCard([null]))
          : JSON.stringify(
              fullCard([
                {
                  kind: "other",
                  label: "",
                  description: "",
                  anchors: [{ claim: "", quote: "GOOD BODY" }],
                },
              ]),
            ),
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
      text: JSON.stringify(
        fullCard([{ kind: "concept", label: "Idea", description: "Description", anchors: [] }]),
      ),
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
      text: JSON.stringify(
        fullCard([{ kind: "concept", label: "Idea", description: "Description", anchors: [] }]),
      ),
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
      text: JSON.stringify(
        fullCard([{ kind: "concept", label: "Idea", description: "Description", anchors: [] }]),
      ),
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
        text: attempt === 1 ? "{malformed-secret-shaped-output}" : JSON.stringify(fullCard([])),
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
    const events = await run(
      Effect.flatMap(Database, (db) =>
        db.query((d) => d.select().from(llmCostEvents)).pipe(Effect.orDie),
      ),
    );
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.phase === "extract")).toBe(true);
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
    ).rejects.toThrow("validate_cleanup response does not match its contract");
  });

  it("ingest indexes path-sorted metadata/body chunks and skips an unchanged ETag replay", async () => {
    const content =
      `---\nsource_id: ${id.source}\ntitle: Source title\nprecis: Source precis\nauthor: Author\n---\n# Heading\n\nFirst paragraph ^p0\n\nSecond paragraph ^p1\n`;
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

  it("ingest withholds the ETag for a timed-out embedding batch so the next run re-indexes it", async () => {
    const content = `---\nsource_id: ${id.source}\ntitle: Source title\n---\n# Heading\n\nBody\n`;
    files.set("raw/docs/source.md", content);
    etags.set("raw/docs/source.md", "etag-one");
    await run(
      Effect.flatMap(Database, (db) => db.query((d) => d
        .insert(sourceDocuments)
        .values({
          id: id.source,
          vaultId: id.vault,
          filePath: "raw/docs/source.md",
          fileHash: "file",
          bodyHash: "body",
          sourceType: "document",
        }))
        .pipe(Effect.orDie)),
    );
    embed = async () => {
      throw new DOMException("embedding timed out", "TimeoutError");
    };

    await run(Effect.flatMap(CompilePhases, (phases) => phases.ingest(id.vault, id.run)));

    const indexed = () =>
      run(
        Effect.flatMap(Database, (db) => db.query((d) => d
          .select({ chunkIndex: searchIndex.chunkIndex })
          .from(searchIndex)
          .orderBy(searchIndex.chunkIndex))
          .pipe(Effect.orDie)),
      );
    const storedEtag = () =>
      run(
        Effect.flatMap(Database, (db) => db.query((d) => d
          .select({ etag: sourceDocuments.etag })
          .from(sourceDocuments)
          .where(eq(sourceDocuments.id, id.source)))
          .pipe(Effect.orDie)),
      );
    expect(await indexed()).toEqual([]);
    expect(await storedEtag()).toEqual([{ etag: null }]);
    expect(logEvents).toContainEqual({
      event: "search_index.embed_batch_timeout",
      fields: expect.objectContaining({ scope: "raw", batch_size: 2, error_type: "TimeoutError" }),
    });

    embed = defaultEmbed;
    embeddingRequests.length = 0;
    await run(Effect.flatMap(CompilePhases, (phases) => phases.ingest(id.vault, id.run)));
    expect(embeddingRequests).toHaveLength(1);
    expect(await indexed()).toEqual([{ chunkIndex: -1 }, { chunkIndex: 0 }]);
    expect(await storedEtag()).toEqual([{ etag: "etag-one" }]);
  });

  it("ingest fails loudly on a non-timeout embedding error", async () => {
    files.set("raw/docs/source.md", `---\nsource_id: ${id.source}\n---\n# Heading\n\nBody\n`);
    await run(
      Effect.flatMap(Database, (db) => db.query((d) => d
        .insert(sourceDocuments)
        .values({
          id: id.source,
          vaultId: id.vault,
          filePath: "raw/docs/source.md",
          fileHash: "file",
          bodyHash: "body",
          sourceType: "document",
        }))
        .pipe(Effect.orDie)),
    );
    embed = async () => {
      throw new Error("revoked credential");
    };

    await expect(
      run(Effect.flatMap(CompilePhases, (phases) => phases.ingest(id.vault, id.run))),
    ).rejects.toThrow("revoked credential");
  });

  it("reconciles a moved source path from immutable frontmatter identity", async () => {
    const oldPath = "raw/books/original.md";
    const movedPath = `raw/moved/${id.source}-renamed.md`;
    const body = "# Moved source\n\nThe source body remains attached to its identity. ^p0\n";
    const content = `---\nsource_id: ${id.source}\nsource_type: book\n---\n${body}`;
    files.set(movedPath, content);
    etags.set(movedPath, "etag-moved");

    const state = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(sourceDocuments)
          .values({
            id: id.source,
            vaultId: id.vault,
            filePath: oldPath,
            fileHash: "old-file-hash",
            bodyHash: "old-body-hash",
            clientHash: "a".repeat(64),
            etag: "etag-original",
            sourceType: "book",
            title: "Original title",
            precis: "Keep this derived precis",
            tags: ["keep-this-tag"],
            derivedExtras: { retained: true },
          }))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
          .insert(ideas)
          .values({
            ideaId: id.ideaA,
            vaultId: id.vault,
            documentId: id.source,
            kind: "concept",
            label: "Stable idea",
            description: "Must retain the source ID relationship",
          }))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
          .insert(searchIndex)
          .values({
            vaultId: id.vault,
            path: oldPath,
            chunkIndex: 0,
            heading: "Original",
            body: "Old indexed body",
            contentHash: "old-chunk-hash",
            tsv: sql`to_tsvector('english', 'Old indexed body')`,
          }))
          .pipe(Effect.orDie);

        const phases = yield* CompilePhases;
        yield* phases.ingest(id.vault, id.run);
        return {
          sources: yield* db.query((d) => d.select().from(sourceDocuments)).pipe(Effect.orDie),
          ideas: yield* db.query((d) => d.select().from(ideas)).pipe(Effect.orDie),
          search: yield* db.query((d) => d.select().from(searchIndex)).pipe(Effect.orDie),
        };
      }),
    );

    expect(state.sources).toHaveLength(1);
    expect(state.sources[0]).toMatchObject({
      id: id.source,
      filePath: movedPath,
      fileHash: fileContentHash(content),
      bodyHash: bodyContentHash(body),
      clientHash: "a".repeat(64),
      etag: "etag-moved",
      sourceType: "book",
      title: "Moved source",
      precis: "Keep this derived precis",
      tags: ["keep-this-tag"],
      derivedExtras: { retained: true },
    });
    expect(state.ideas).toHaveLength(1);
    expect(state.ideas[0]?.documentId).toBe(id.source);
    expect(state.search.length).toBeGreaterThan(0);
    expect(new Set(state.search.map((row) => row.path))).toEqual(new Set([movedPath]));
  });

  it("rejects two storage paths claiming the same source identity", async () => {
    const originalPath = "raw/docs/original.md";
    const duplicatePath = "raw/docs/copied.md";
    const content = `---\nsource_id: ${id.source}\nsource_type: document\n---\n# Duplicate identity\n`;
    files.set(originalPath, content);
    files.set(duplicatePath, content);
    await run(
      Effect.flatMap(Database, (db) =>
        db.query((d) => d
          .insert(sourceDocuments)
          .values({
            id: id.source,
            vaultId: id.vault,
            filePath: originalPath,
            fileHash: fileContentHash(content),
            bodyHash: bodyContentHash("# Duplicate identity\n"),
            sourceType: "document",
          }))
          .pipe(Effect.orDie),
      ),
    );

    await expect(
      run(Effect.flatMap(CompilePhases, (phases) => phases.ingest(id.vault, id.run))),
    ).rejects.toThrow(`Source ${id.source} appears at both ${duplicatePath} and ${originalPath}`);
    const sources = await run(
      Effect.flatMap(Database, (db) =>
        db.query((d) => d.select().from(sourceDocuments)).pipe(Effect.orDie),
      ),
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]?.filePath).toBe(originalPath);
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

  it("writes compile LLM cost before publish and publish adds no rows", async () => {
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
    expect(counts.beforePublish).toHaveLength(1);
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

  const seedGranularityIdeas = async (count: number) => {
    files.set("raw/docs/source.md", "# Source\n\nBody\n");
    const ideaIds = Array.from(
      { length: count },
      (_v, index) => `20000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}` as Uuid,
    );
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .query((d) => d.insert(sourceDocuments).values({
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
        yield* db
          .query((d) => d.insert(ideas).values(
            ideaIds.map((ideaId, index) => ({
              ideaId,
              vaultId: id.vault,
              documentId: id.source,
              kind: "concept",
              label: `Idea ${index}`,
              description: `Description ${index}`,
              embedding: [1, ...Array.from({ length: 1023 }, () => 0)],
            })),
          ))
          .pipe(Effect.orDie);
      }),
    );
    return ideaIds;
  };

  // The synthesize prompt tags ideas idea_1..idea_N; with one document the
  // order matches the chunk order, which is not asserted — structure only.
  const topicJson = (slug: string, tagStart: number, tagEnd: number) => ({
    slug,
    title: `Topic ${slug}`,
    description: `About ${slug}.`,
    subsumed_idea_ids: Array.from(
      { length: tagEnd - tagStart + 1 },
      (_v, index) => `idea_${tagStart + index}`,
    ),
  });

  const scriptGranularity = (script: {
    readonly synthesize: unknown;
    readonly revise?: (call: number) => unknown;
    readonly decompose?: unknown;
  }) => {
    const calls: string[] = [];
    let reviseCalls = 0;
    complete = async (input) => {
      const content = input.messages
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : (message.content ?? []).map((part) => ("text" in part ? part.text : "")).join("\n"),
        )
        .join("\n");
      const respond = (value: unknown) => ({ text: JSON.stringify(value), finishReason: "stop" });
      if (content.includes("You are refining a list of thematic topics")) {
        calls.push("revise");
        reviseCalls += 1;
        if (script.revise === undefined) throw new Error("unexpected revise call");
        return respond(script.revise(reviseCalls));
      }
      if (content.includes("You are examining one proposed thematic topic")) {
        calls.push("decompose");
        if (script.decompose === undefined) throw new Error("unexpected decompose call");
        return respond(script.decompose);
      }
      if (content.includes("You are proposing thematic topics")) {
        calls.push("synthesize");
        return respond(script.synthesize);
      }
      if (content.includes("designing the canonical table of contents")) {
        calls.push("registry");
        return respond({
          topics: [
            {
              title: "Canonical Topic",
              description: "Canonical description",
              link_targets: [],
            },
          ],
        });
      }
      if (content.includes("filing candidate sub-topics")) {
        calls.push("assign");
        const batchSize = (content.match(/^\d+\. .* :: /gmu) ?? []).length;
        return respond({
          assignments: Array.from({ length: batchSize }, (_v, index) => ({
            n: index + 1,
            slug: "canonical-topic",
          })),
        });
      }
      throw new Error(`unexpected compile LLM call: ${content.slice(0, 80)}`);
    };
    return calls;
  };

  const cachedSynthesizedTopics = async (ideaIds: readonly Uuid[]) => {
    const cacheKey = synthesizeCacheKey({
      ideaIds,
      promptHash: await combinedSynthesizePromptHash(),
      model: config.mapModel,
    });
    const rows = await run(
      Effect.flatMap(Database, (db) =>
        db
          .query((d) => d
            .select()
            .from(compileCacheEntries)
            .where(eq(compileCacheEntries.cacheKey, cacheKey)))
          .pipe(Effect.orDie),
      ),
    );
    expect(rows).toHaveLength(1);
    const value = rows[0]?.value as { local_topics: { subsumed_idea_ids: string[] }[] };
    return value.local_topics;
  };

  it("revises nested synthesize output and caches the accepted revision", async () => {
    const ideaIds = await seedGranularityIdeas(10);
    const calls = scriptGranularity({
      synthesize: { topics: [topicJson("umbrella", 1, 10), topicJson("facet", 1, 8)] },
      revise: () => ({ topics: [topicJson("facet", 1, 8), topicJson("remainder", 9, 10)] }),
    });
    await run(Effect.flatMap(CompilePhases, (phases) => phases.abstract(id.vault, id.run)));
    expect(calls.filter((name) => name === "revise")).toHaveLength(1);
    const cached = await cachedSynthesizedTopics(ideaIds);
    expect(cached.map((topic) => topic.subsumed_idea_ids.length).toSorted()).toEqual([2, 8]);
    expect(new Set(cached.flatMap((topic) => topic.subsumed_idea_ids)).size).toBe(10);
    expect(logEvents.map((entry) => entry.event)).not.toContain("synthesize_nesting_floor");
  });

  it("applies the mechanical floor when revision keeps nesting, and logs it", async () => {
    const ideaIds = await seedGranularityIdeas(10);
    const nested = { topics: [topicJson("umbrella", 1, 10), topicJson("facet", 1, 8)] };
    const calls = scriptGranularity({ synthesize: nested, revise: () => nested });
    await run(Effect.flatMap(CompilePhases, (phases) => phases.abstract(id.vault, id.run)));
    expect(calls.filter((name) => name === "revise")).toHaveLength(2);
    const cached = await cachedSynthesizedTopics(ideaIds);
    // Umbrella shrinks to its 2-idea residue; too small to drop because the
    // residue ideas survive nowhere else.
    expect(cached.map((topic) => topic.subsumed_idea_ids.length).toSorted()).toEqual([2, 8]);
    expect(new Set(cached.flatMap((topic) => topic.subsumed_idea_ids)).size).toBe(10);
    expect(logEvents.map((entry) => entry.event)).toContain("synthesize_nesting_floor");
  });

  it("decomposes a chunk-covering topic and caches the replacement", async () => {
    const ideaIds = await seedGranularityIdeas(24);
    const calls = scriptGranularity({
      synthesize: { topics: [topicJson("everything", 1, 24)] },
      decompose: { topics: [topicJson("first-half", 1, 12), topicJson("second-half", 13, 24)] },
    });
    await run(Effect.flatMap(CompilePhases, (phases) => phases.abstract(id.vault, id.run)));
    expect(calls).toContain("decompose");
    const cached = await cachedSynthesizedTopics(ideaIds);
    expect(cached.map((topic) => topic.subsumed_idea_ids.length)).toEqual([12, 12]);
    expect(new Set(cached.flatMap((topic) => topic.subsumed_idea_ids)).size).toBe(24);
  });

  it("keeps the original topic when decomposition loses idea coverage", async () => {
    const ideaIds = await seedGranularityIdeas(24);
    const calls = scriptGranularity({
      synthesize: { topics: [topicJson("everything", 1, 24)] },
      decompose: { topics: [topicJson("partial", 1, 12)] },
    });
    await run(Effect.flatMap(CompilePhases, (phases) => phases.abstract(id.vault, id.run)));
    expect(calls).toContain("decompose");
    const cached = await cachedSynthesizedTopics(ideaIds);
    expect(cached.map((topic) => topic.subsumed_idea_ids.length)).toEqual([24]);
    expect(logEvents.map((entry) => entry.event)).toContain("synthesize_decompose_rejected");
  });

  const seedPriorTopic = async (slug: string, memberIdeaIds: readonly Uuid[]) => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .query((d) => d.insert(topics).values({
            topicId: id.topicB,
            vaultId: id.vault,
            slug,
            title: "Prior Topic",
            description: "Prior description",
            articleStatus: "rendered",
          }))
          .pipe(Effect.orDie);
        yield* db
          .query((d) => d.insert(topicMembership).values(
            memberIdeaIds.map((ideaId) => ({ topicId: id.topicB, ideaId })),
          ))
          .pipe(Effect.orDie);
      }),
    );
  };

  // The granularity script has no cleanup branch — it throws on a cleanup
  // call — so these tests also prove the mechanical paths skip the LLM.
  it("carries a renamed topic's identity by composition without a cleanup call", async () => {
    const ideaIds = await seedGranularityIdeas(6);
    await seedPriorTopic("old-name", ideaIds);
    scriptGranularity({ synthesize: { topics: [topicJson("everything", 1, 6)] } });

    const validated = await run(
      Effect.flatMap(CompilePhases, (phases) => phases.abstract(id.vault, id.run)),
    );

    expect(validated).toHaveLength(1);
    expect(validated[0]?.topicId).toBe(id.topicB);
    expect(validated[0]?.slug).toBe("canonical-topic");
    const rows = await run(
      Effect.flatMap(Database, (db) =>
        db
          .query((d) => d.select().from(topics).where(eq(topics.topicId, id.topicB)))
          .pipe(Effect.orDie),
      ),
    );
    expect(rows[0]?.slug).toBe("canonical-topic");
    expect(rows[0]?.articleStatus).toBe("rendered");
    const resolved = logEvents.find((entry) => entry.event === "composition_identity_resolved");
    expect(resolved?.fields).toMatchObject({ carried: 1, archived_mechanical: 0, residue: 0 });
  });

  it("archives an absorbed topic with a mechanical successor and no cleanup call", async () => {
    const ideaIds = await seedGranularityIdeas(8);
    await seedPriorTopic("absorbed", ideaIds.slice(0, 3));
    scriptGranularity({ synthesize: { topics: [topicJson("everything", 1, 8)] } });

    const validated = await run(
      Effect.flatMap(CompilePhases, (phases) => phases.abstract(id.vault, id.run)),
    );

    expect(validated).toHaveLength(1);
    expect(validated[0]?.topicId).not.toBe(id.topicB);
    const rows = await run(
      Effect.flatMap(Database, (db) =>
        db
          .query((d) => d.select().from(topics).where(eq(topics.topicId, id.topicB)))
          .pipe(Effect.orDie),
      ),
    );
    expect(rows[0]?.articleStatus).toBe("archived");
    expect(rows[0]?.supersededBy).toBe(validated[0]?.topicId);
    const resolved = logEvents.find((entry) => entry.event === "composition_identity_resolved");
    expect(resolved?.fields).toMatchObject({ carried: 0, archived_mechanical: 1, residue: 0 });
  });
});
