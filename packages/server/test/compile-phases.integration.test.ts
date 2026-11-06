import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  anchors,
  backlinks,
  compileCacheEntries,
  Database,
  DatabaseLive,
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
  vaultMemberships,
  vaults,
  wikiArticles,
} from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { eq, sql } from "drizzle-orm";
import { Effect, Exit, Layer, Option, Redacted, Schema, Stream } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
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
import { PgClientLive } from "../src/db.ts";
import { EmbeddingBatchFailed, EmbeddingsService } from "../src/embeddings.ts";
import {
  LanguageModel,
  type CompleteInput,
  type ModelCompletion,
  ModelProviderError,
} from "../src/llm.ts";
import { StructuredLogger } from "../src/logging.ts";
import { parseFrontmatter, serializeFrontmatter } from "../src/markdown.ts";
import { PipelineRunsServiceLive } from "../src/pipeline-runs.ts";
import { RandomBytesLive } from "../src/random.ts";
import { SourceDocumentsService, SourceDocumentsServiceLive } from "../src/source-documents.ts";
import { ContentStorage } from "../src/storage.ts";
import { seedLegacySources, versionedSourceStorage } from "./fixtures/source-documents.ts";
import {
  replyHistoryTestDatabaseUrl,
  runHistoryDatabase,
} from "./fixtures/reply-history-database.ts";

const uuid = Schema.decodeUnknownSync(Uuid);

const id = {
  user: uuid("20000000-0000-4000-8000-000000000001"),
  vault: uuid("20000000-0000-4000-8000-000000000002"),
  run: uuid("20000000-0000-4000-8000-000000000003"),
  source: uuid("20000000-0000-4000-8000-000000000004"),
  sourceB: uuid("20000000-0000-4000-8000-000000000013"),
  ideaA: uuid("20000000-0000-4000-8000-000000000005"),
  ideaB: uuid("20000000-0000-4000-8000-000000000006"),
  ideaC: uuid("20000000-0000-4000-8000-000000000007"),
  topicA: uuid("20000000-0000-4000-8000-000000000008"),
  topicB: uuid("20000000-0000-4000-8000-000000000009"),
  topicC: uuid("20000000-0000-4000-8000-000000000010"),
  articleA: uuid("20000000-0000-4000-8000-000000000011"),
  articleB: uuid("20000000-0000-4000-8000-000000000012"),
  membership: uuid("20000000-0000-4000-8000-000000000014"),
} as const;

const dataDir = await mkdtemp(join(tmpdir(), "gm-compile-phases-"));
const config: AppConfigShape = {
  databaseUrl: Redacted.make(replyHistoryTestDatabaseUrl),
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
  extractTemperature: Option.some(0.2),
  mapTemperature: Option.some(0.3),
  reduceTemperature: Option.none(),
  renderTemperature: Option.none(),
  renderReasoningEffort: Option.none(),
  compileEnrichConcurrency: 1,
  compileWriteConcurrency: 1,
  compilePartitionTargetTokens: 100_000,
  compilePartitionMinFactor: 0.3,
  compilePartitionMaxFactor: 1.5,
  compilePremergeJaccardThreshold: 0.8,
  compileDeriveRelatedLimit: 20,
  compileEmbedConcurrency: 4,
  pipelineConcurrency: 1,
  embeddingModel: "qwen/qwen3-embedding-8b",
  embeddingProviders: [],
  corsOrigins: [],
  publicWebUrl: new URL("http://localhost:5173"),
  typstBinary: "typst",
  suppressAuth: false,
  clientIpHeader: Option.none(),
  allowPrivateUrlFetch: false,
  serverHost: "127.0.0.1",
  serverPort: 0,
};

const files = new Map<string, string>();
const etags = new Map<string, string>();
const storageReads: string[] = [];
const embeddingRequests: string[][] = [];
const logEvents: { readonly event: string; readonly fields: Record<string, unknown> }[] = [];

const defaultEmbed = async (texts: readonly string[]) => {
  embeddingRequests.push([...texts]);
  return texts.map(() => [1, ...Array.from({ length: 1023 }, () => 0)]);
};
let embed = defaultEmbed;
let failWritePath: string | null = null;
let complete = async (_input: CompleteInput): Promise<ModelCompletion> => {
  throw new Error("unexpected compile LLM call");
};

const writeFile = (path: string, content: string) => {
  files.set(path, content);
  if (path === failWritePath) throw new Error("compile replay write fault");
};

const sourceStorage = versionedSourceStorage(files, writeFile);
const StorageLive = Layer.succeed(ContentStorage, {
  ...sourceStorage,
  readText: (owner, path) =>
    Effect.suspend(() => {
      storageReads.push(path);
      return sourceStorage.readText(owner, path);
    }),
  readVersionedText: (owner, path) =>
    Effect.suspend(() => {
      storageReads.push(path);
      return sourceStorage.readVersionedText(owner, path);
    }),
  listMarkdown: (_vaultId, scope) =>
    Effect.succeed(
      [...files.keys()]
        .filter((path) => path.startsWith(`${scope}/`) && path.endsWith(".md"))
        .filter((path) => scope === "raw" || !path.slice("wiki/".length).includes("/"))
        .sort()
        .map((path) => ({ path, etag: etags.get(path) ?? null })),
    ),
  writeText: (_vaultId, path, content) => Effect.sync(() => writeFile(path, content)),
  deletePath: (_vaultId, path) => Effect.sync(() => files.delete(path)).pipe(Effect.asVoid),
  clear: () => Effect.void,
});

const ConfigLive = Layer.succeed(AppConfig, config);
const BaseLive = Layer.mergeAll(
  DatabaseLive.pipe(Layer.provide(PgClientLive), Layer.provideMerge(ConfigLive)),
  ClockLive,
  RandomBytesLive,
);
const PipelineLive = PipelineRunsServiceLive.pipe(Layer.provideMerge(BaseLive));
const SourceDocumentsLive = SourceDocumentsServiceLive.pipe(
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(BaseLive),
);
const EmbeddingsLive = Layer.succeed(EmbeddingsService, {
  embed: (texts) =>
    Effect.tryPromise({
      try: () => embed(texts),
      catch: (cause) =>
        new EmbeddingBatchFailed({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }),
});
const LanguageModelLive = Layer.succeed(LanguageModel, {
  hasApiKey: true,
  streamChat: () => Stream.empty,
  complete: (input) =>
    Effect.tryPromise({
      try: () => complete(input),
      catch: (cause) => new ModelProviderError({ message: "scripted completion failed", cause }),
    }),
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

const run = <A>(
  effect: Effect.Effect<A, unknown, Database | CompilePhases | SourceDocumentsService>,
) => Effect.runPromise(effect.pipe(Effect.provide(TestLive)));

const seedBase = () =>
  run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d.delete(users)).pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(users)
        .values({ id: id.user, email: "phases@example.com" }))
        .pipe(Effect.orDie);
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .insert(vaults)
            .values({ id: id.vault, name: "Compile Phases", ownerId: id.user });
          yield* tx
            .insert(vaultMemberships)
            .values({ id: id.membership, vaultId: id.vault, userId: id.user, role: "EDITOR" });
        }),
      );
      yield* db.query((d) => d
        .insert(pipelineRuns)
        .values({
          id: id.run,
          vaultId: id.vault,
          trigger: "manual",
          status: "pending",
          currentPhase: "",
          phaseStatus: "",
        }))
        .pipe(Effect.orDie);
    }),
  );

const insertSource = async (
  documentId: Uuid,
  filePath: string,
  canonicalUrl: string | null = null,
) => {
  const original = files.get(filePath);
  if (original === undefined) throw new Error(`Source fixture has no file at ${filePath}`);
  const parsed = parseFrontmatter(original);
  const content = serializeFrontmatter(
    { ...parsed.frontmatter, source_id: documentId },
    parsed.body,
  );
  files.set(filePath, content);
  const bodyHash = bodyContentHash(parsed.body);
  await run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.transaction((tx) =>
        seedLegacySources(tx, {
          id: documentId,
          vaultId: id.vault,
          filePath,
          fileHash: fileContentHash(content),
          bodyHash,
          sourceType: "document",
          canonicalUrl,
        }),
      );
    }),
  );
  return bodyHash;
};

const seedSourceAndIdeas = async () => {
  const path = "raw/docs/source.md";
  if (!files.has(path)) files.set(path, "# Source\n\nBody\n");
  await insertSource(id.source, path);
  await run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) =>
        d.insert(ideas).values(
          [id.ideaA, id.ideaB, id.ideaC].map((ideaId, index) => ({
            ideaId,
            vaultId: id.vault,
            documentId: id.source,
            kind: "claim",
            label: `Idea ${index}`,
            description: `Description ${index}`,
          })),
        ),
      );
    }),
  );
};

const defaultPrompt = async (name: string) =>
  (await readFile(new URL(`../src/default_prompts/${name}.md`, import.meta.url), "utf8")).trim();

const validated: readonly ValidatedTopic[] = [
  {
    topicId: id.topicA,
    slug: "alpha",
    title: "Alpha",
    description: "Alpha description",
    subsumedIdeaIds: [id.ideaA, id.ideaB],
  },
  {
    topicId: id.topicB,
    slug: "beta",
    title: "Beta",
    description: "Beta description",
    subsumedIdeaIds: [id.ideaB, id.ideaC],
  },
];

describe("M4.3a deterministic compile phases", () => {
  beforeAll(() => runHistoryDatabase(Effect.void));

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    files.clear();
    etags.clear();
    storageReads.length = 0;
    embeddingRequests.length = 0;
    logEvents.length = 0;
    embed = defaultEmbed;
    failWritePath = null;
    complete = async () => {
      throw new Error("unexpected compile LLM call");
    };
    await seedBase();
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
    await insertSource(id.source, "raw/docs/source.md", canonicalUrl);
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

  it("repairs extract projections after a lost write acknowledgment without regenerating identities or embeddings", async () => {
    const path = "raw/docs/source.md";
    files.set(path, `---\nsource_id: ${id.source}\n---\n# Source\n\nBody\n`);
    await seedSourceAndIdeas();
    let modelCalls = 0;
    complete = async () => {
      modelCalls += 1;
      return {
        text: JSON.stringify({
          ...fullCard([
            {
              kind: "concept",
              label: "Current",
              description: "Current idea",
              anchors: [{ claim: "Current claim", quote: "Body" }],
            },
          ]),
          title: "Recovered title",
          precis: "Recovered precis",
          tags: ["recovered"],
        }),
        finishReason: "stop",
      };
    };
    const extract = Effect.flatMap(CompilePhases, (phases) => phases.extract(id.vault, id.run));
    failWritePath = path;
    try {
      expect(Exit.isFailure(await run(Effect.exit(extract)))).toBe(true);
    } finally {
      failWritePath = null;
    }
    const state = () =>
      run(
        Effect.gen(function* () {
          const db = yield* Database;
          return {
            cache: yield* db.query((d) => d.select().from(compileCacheEntries)),
            ideas: yield* db.query((d) => d.select().from(ideas)),
            anchors: yield* db.query((d) => d.select().from(anchors)),
            source: yield* db.query((d) => d.select().from(sourceDocuments)),
          };
        }),
      );
    const partial = await state();
    expect(partial.cache).toHaveLength(1);
    const persistedIdea = partial.ideas.find((idea) => idea.label === "Current");
    expect(persistedIdea).toBeDefined();
    embeddingRequests.length = 0;
    await run(extract);
    const repaired = await state();
    expect(repaired.cache).toEqual(partial.cache);
    expect(repaired.ideas).toEqual([persistedIdea]);
    expect(repaired.anchors).toEqual([
      {
        ideaId: persistedIdea?.ideaId,
        position: 0,
        claim: "Current claim",
        quote: "Body",
        chunkIndex: 0,
      },
    ]);
    expect(repaired.source[0]).toMatchObject({
      title: "Recovered title",
      precis: "Recovered precis",
      tags: ["recovered"],
      fileHash: fileContentHash(files.get(path)!),
    });
    expect(parseFrontmatter(files.get(path)!).frontmatter).toMatchObject({
      title: "Recovered title",
      precis: "Recovered precis",
      tags: ["recovered"],
    });
    await run(extract);
    const replayed = await state();
    expect(replayed.ideas).toEqual(repaired.ideas);
    expect(replayed.anchors).toEqual(repaired.anchors);
    expect(embeddingRequests).toHaveLength(0);
    expect(modelCalls).toBe(1);
  });

  it("does not project an old extraction onto a deleted and re-imported source", async () => {
    const path = "raw/docs/source.md";
    files.set(path, "# Original\n\nOriginal body.\n");
    await insertSource(id.source, path);
    let announce = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    complete = async () => {
      announce();
      await released;
      return {
        text: JSON.stringify({
          ...fullCard([
            {
              kind: "concept",
              label: "Old idea",
              description: "Old description",
              anchors: [{ claim: "Old claim", quote: "Original body." }],
            },
          ]),
          title: "Old generated title",
          precis: "Old generated precis",
        }),
        finishReason: "stop",
      };
    };
    const extracting = run(
      Effect.flatMap(CompilePhases, (phases) => phases.extract(id.vault, id.run)),
    );
    try {
      await Promise.race([
        started,
        extracting.then(() => {
          throw new Error("Extraction did not call the model");
        }),
      ]);
      await run(
        Effect.gen(function* () {
          const sources = yield* SourceDocumentsService;
          expect(yield* sources.deleteSource(id.vault, id.source)).toBe(true);
          const replacement = yield* sources.admit(id.vault, id.source, path);
          yield* sources.write(replacement, "# Replacement\n\nFresh body.\n", null);
        }),
      );
    } finally {
      release();
      await extracting;
    }
    const state = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return {
          ideas: yield* db.query((tx) => tx.select().from(ideas)),
          anchors: yield* db.query((tx) => tx.select().from(anchors)),
          sources: yield* db.query((tx) => tx.select().from(sourceDocuments)),
          cache: yield* db.query((tx) => tx.select().from(compileCacheEntries)),
        };
      }),
    );
    expect(state.cache).toHaveLength(1);
    expect(state.ideas).toEqual([]);
    expect(state.anchors).toEqual([]);
    expect(state.sources).toEqual([
      expect.objectContaining({ id: id.source, title: "Replacement", precis: null }),
    ]);
    expect(parseFrontmatter(files.get(path)!).body).toBe("# Replacement\n\nFresh body.\n");
    expect(parseFrontmatter(files.get(path)!).frontmatter.precis).toBeUndefined();
  });

  it("isolates malformed extract output per document under the strict contract", async () => {
    files.set("raw/docs/bad.md", "# Bad\n\nMALFORMED\n");
    files.set("raw/docs/good.md", "# Good\n\nGOOD\u0085BODY\n");
    await insertSource(id.source, "raw/docs/bad.md");
    await insertSource(id.sourceB, "raw/docs/good.md");
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

  it.each([
    { title: "drifted" },
    { ...fullCard([]), document_id: id.sourceB },
    {
      ...fullCard([
        {
          idea_id: id.ideaA,
          document_id: id.sourceB,
          kind: "concept",
          label: "Foreign idea",
          description: "Wrong source",
        },
      ]),
      document_id: id.source,
    },
  ])("rejects malformed or foreign extract cache without refetching the LLM: %j", async (card) => {
    const path = "raw/docs/source.md";
    const content = serializeFrontmatter({ source_id: id.source }, "# Source\n\nBody\n");
    files.set(path, content);
    const bodyHash = await insertSource(id.source, path);
    const template = (await defaultPrompt("extract"))
      .replace("{kinds}", "person, event, organization, concept")
      .replace("{vault_enriched_fields}", "");
    await run(
      Effect.flatMap(Database, (db) =>
        db.query((d) =>
          d.insert(compileCacheEntries).values({
            vaultId: id.vault,
            phase: "extract",
            cacheKey: contentHash(
              `doc=${id.source}`,
              bodyHash,
              `prompt=${promptContentHash(template)}`,
              `model=${config.extractModel}`,
            ),
            value: { source_card: card },
          }),
        ),
      ),
    );
    let calls = 0;
    complete = async () => {
      calls += 1;
      throw new Error("unexpected model call for an existing cache row");
    };
    await run(Effect.flatMap(CompilePhases, (phases) => phases.extract(id.vault, id.run)));
    expect(calls).toBe(0);
    expect(logEvents).toContainEqual({
      event: "doc_failed",
      fields: expect.objectContaining({ error_type: "MalformedCompileCache" }),
    });
    expect(files.get(path)).toBe(content);
    expect(
      await run(Effect.flatMap(Database, (db) => db.query((d) => d.select().from(ideas)))),
    ).toEqual([]);
  });

  it("fails extract loudly on a non-timeout embedding error", async () => {
    files.set("raw/docs/source.md", "# Source\n\nBody\n");
    await insertSource(id.source, "raw/docs/source.md");
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
    await insertSource(id.source, "raw/docs/source.md");
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
    await insertSource(id.source, "raw/docs/source.md");
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

  it.each(["fenced", "truncated"] as const)(
    "handles %s model JSON at the compile boundary",
    async (kind) => {
      files.set("raw/docs/source.md", "# Source\n\nBody\n");
      await insertSource(id.source, "raw/docs/source.md");
      let calls = 0;
      complete = async () => {
        calls += 1;
        const text = JSON.stringify(fullCard([]));
        return {
          text: kind === "fenced" ? `\`\`\`json\n${text}\n\`\`\`` : text,
          finishReason: kind === "truncated" ? "length" : "stop",
        };
      };
      await run(Effect.flatMap(CompilePhases, (phases) => phases.extract(id.vault, id.run)));
      expect(calls).toBe(1);
      const cached = await run(
        Effect.flatMap(Database, (db) => db.query((d) => d.select().from(compileCacheEntries))),
      );
      expect(cached).toHaveLength(kind === "fenced" ? 1 : 0);
      expect(logEvents.filter((entry) => entry.event === "doc_failed")).toHaveLength(
        kind === "fenced" ? 0 : 1,
      );
    },
  );

  it("warns on a JSON parse retry without logging the malformed response", async () => {
    files.set("raw/docs/source.md", "# Source\n\nBody\n");
    await insertSource(id.source, "raw/docs/source.md");
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
      error_type: "MalformedLlmOutput",
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

  it("ingest indexes path-sorted metadata/body chunks and skips an unchanged ETag replay", async () => {
    const content =
      `---\nsource_id: ${id.source}\ntitle: Source title\nprecis: Source precis\nauthor: Author\n---\n# Heading\n\nFirst paragraph ^p0\n\nSecond paragraph ^p1\n`;
    files.set("raw/docs/source.md", content);
    etags.set("raw/docs/source.md", "etag-one");
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .transaction((tx) =>
            seedLegacySources(tx, {
              id: id.source,
              vaultId: id.vault,
              filePath: "raw/docs/source.md",
              fileHash: "file",
              bodyHash: "body",
              sourceType: "document",
            }),
          )
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

  it("ingest indexes every chunk of a document longer than one search write", async () => {
    const paragraphs = Array.from({ length: 450 }, (_unused, index) => `Paragraph ${index} ^p${index}`);
    files.set(
      "raw/docs/long.md",
      `---\nsource_id: ${id.source}\ntitle: Long\n---\n${paragraphs.join("\n\n")}\n`,
    );
    etags.set("raw/docs/long.md", "etag-long");
    let inFlight = 0;
    let mostInFlight = 0;
    embed = async (texts) => {
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return texts.map((text) => {
        const paragraph = /Paragraph (\d+)/.exec(text);
        return [1, paragraph === null ? -1 : Number(paragraph[1]), ...Array.from({ length: 1022 }, () => 0)];
      });
    };
    const indexed = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db
          .transaction((tx) =>
            seedLegacySources(tx, {
              id: id.source,
              vaultId: id.vault,
              filePath: "raw/docs/long.md",
              fileHash: "file",
              bodyHash: "body",
              sourceType: "document",
            }),
          )
          .pipe(Effect.orDie);
        const phases = yield* CompilePhases;
        yield* phases.ingest(id.vault, id.run);
        return yield* db
          .query((d) =>
            d
              .select({
                chunkIndex: searchIndex.chunkIndex,
                marker: sql<number>`(${searchIndex.embedding}::real[])[2]`,
              })
              .from(searchIndex),
          )
          .pipe(Effect.orDie);
      }),
    );
    expect(indexed.map((row) => row.chunkIndex).toSorted((left, right) => left - right)).toEqual([
      -1,
      ...paragraphs.map((_paragraph, index) => index),
    ]);
    expect(indexed.every((row) => row.marker === (row.chunkIndex === -1 ? -1 : row.chunkIndex))).toBe(
      true,
    );
    expect(mostInFlight).toBeGreaterThan(1);
    expect(mostInFlight).toBeLessThanOrEqual(config.compileEmbedConcurrency);
  });

  it("extract keeps an unchanged source's ETag and date, so the next ingest reads nothing", async () => {
    const path = "raw/docs/source.md";
    files.set(path, `---\nsource_id: ${id.source}\n---\n# Source\n\nBody\n`);
    etags.set(path, "etag-one");
    await insertSource(id.source, path);
    complete = async () => ({
      text: JSON.stringify({
        ...fullCard([
          {
            kind: "concept",
            label: "Idea",
            description: "Description",
            anchors: [{ claim: "Claim", quote: "Body" }],
          },
        ]),
        title: "Extracted title",
        precis: "Extracted precis",
      }),
      finishReason: "stop",
    });
    const ingest = Effect.flatMap(CompilePhases, (phases) => phases.ingest(id.vault, id.run));
    const extract = Effect.flatMap(CompilePhases, (phases) => phases.extract(id.vault, id.run));
    const registry = () =>
      run(
        Effect.flatMap(Database, (db) => db.query((d) => d
          .select({ etag: sourceDocuments.etag, updatedAt: sourceDocuments.updatedAt })
          .from(sourceDocuments)
          .where(eq(sourceDocuments.id, id.source)))
          .pipe(Effect.orDie)),
      );

    await run(ingest);
    await run(extract);
    const rewritten = files.get(path);
    expect(parseFrontmatter(rewritten ?? "").frontmatter).toMatchObject({
      title: "Extracted title",
    });
    expect(await registry()).toEqual([{ etag: null, updatedAt: expect.any(Date) }]);
    etags.set(path, "etag-two");
    await run(ingest);
    await run(extract);
    expect(files.get(path)).toBe(rewritten);
    const settled = await registry();
    expect(settled).toEqual([{ etag: "etag-two", updatedAt: expect.any(Date) }]);
    const anchorVersions = () =>
      run(
        Effect.flatMap(Database, (db) =>
          db.query((d) => d.select({ version: sql<string>`xmin::text` }).from(anchors)).pipe(Effect.orDie),
        ),
      );
    const versions = await anchorVersions();
    expect(versions).toHaveLength(1);

    storageReads.length = 0;
    await run(ingest);
    expect(storageReads).toEqual([]);
    await run(extract);
    expect(await registry()).toEqual(settled);
    expect(await anchorVersions()).toEqual(versions);
    storageReads.length = 0;
    embeddingRequests.length = 0;
    await run(ingest);
    expect(storageReads).toEqual([]);
    expect(embeddingRequests).toEqual([]);
    expect(await registry()).toEqual(settled);
  });

  it("ingest withholds the ETag for a timed-out embedding batch so the next run re-indexes it", async () => {
    const content = `---\nsource_id: ${id.source}\ntitle: Source title\n---\n# Heading\n\nBody\n`;
    files.set("raw/docs/source.md", content);
    etags.set("raw/docs/source.md", "etag-one");
    await run(
      Effect.flatMap(Database, (db) =>
        db
          .transaction((tx) =>
            seedLegacySources(tx, {
              id: id.source,
              vaultId: id.vault,
              filePath: "raw/docs/source.md",
              fileHash: "file",
              bodyHash: "body",
              sourceType: "document",
            }),
          )
          .pipe(Effect.orDie),
      ),
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
      Effect.flatMap(Database, (db) =>
        db
          .transaction((tx) =>
            seedLegacySources(tx, {
              id: id.source,
              vaultId: id.vault,
              filePath: "raw/docs/source.md",
              fileHash: "file",
              bodyHash: "body",
              sourceType: "document",
            }),
          )
          .pipe(Effect.orDie),
      ),
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
        yield* db
          .transaction((tx) =>
            seedLegacySources(tx, {
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
            }),
          )
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
        db
          .transaction((tx) =>
            seedLegacySources(tx, {
              id: id.source,
              vaultId: id.vault,
              filePath: originalPath,
              fileHash: fileContentHash(content),
              bodyHash: bodyContentHash("# Duplicate identity\n"),
              sourceType: "document",
            }),
          )
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

  it("derive relates articles by the source documents they share and drops removed source memberships", async () => {
    await seedSourceAndIdeas();
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(topics)
          .values(
            validated.map((topic) => ({
              topicId: topic.topicId,
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
    expect(rows.links).toEqual([]);
    expect(rows.related).toEqual([
      { topicId: id.topicA, relatedTopicId: id.topicB, sharedDocuments: 1, jaccard: 1 },
      { topicId: id.topicB, relatedTopicId: id.topicA, sharedDocuments: 1, jaccard: 1 },
    ]);
    const afterDeletion = await run(
      Effect.gen(function* () {
        const sources = yield* SourceDocumentsService;
        const phases = yield* CompilePhases;
        const db = yield* Database;
        yield* sources.deleteSource(id.vault, id.source);
        yield* phases.derive(id.vault, id.run, validated);
        return yield* db.query((tx) => tx.select().from(topicMembership));
      }),
    );
    expect(afterDeletion).toEqual([]);
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
        yield* phases.archiveTransitions(id.vault, id.run, [
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

  it("publish writes exact live indexes plus the local compile log", async () => {
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
              topicId: topic.topicId,
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
        yield* db
          .query((d) =>
            d.insert(backlinks).values({ sourceArticleId: id.articleA, targetArticleId: id.articleB }),
          )
          .pipe(Effect.orDie);
        const phases = yield* CompilePhases;
        yield* phases.publish(id.vault, id.run);
        yield* phases.publish(id.vault, id.run);
      }),
    );
    expect(files.get("wiki/_index.md")).toBe(
      [
        "# Contents",
        "",
        "_2 articles_",
        "",
        "## Start here",
        "",
        "- [Beta](wiki/beta.md) — Beta description",
        "- [Alpha](wiki/alpha.md) — Alpha description",
        "",
        "## All articles",
        "",
        "- [Alpha](wiki/alpha.md) — Alpha description",
        "- [Beta](wiki/beta.md) — Beta description",
        "",
      ].join("\n"),
    );
    expect(files.get("raw/_index.md")).toContain("[raw/docs/source.md](raw/docs/source.md)");
  });
});
