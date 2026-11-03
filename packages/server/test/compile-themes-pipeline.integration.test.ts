import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  anchors,
  backlinks,
  Database,
  DatabaseLive,
  ideas,
  pipelineRuns,
  topicLinks,
  topicMembership,
  topics,
  users,
  vaultMemberships,
  vaults,
  wikiArticles,
} from "@great-minds/database";
import { Uuid } from "@great-minds/domain";
import { Effect, Layer, Option, Redacted, Schema, Stream } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ClockLive } from "../src/clock.ts";
import { CompilePhases, CompilePhasesLive } from "../src/compile-phases.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { PgClientLive } from "../src/db.ts";
import { EmbeddingsService } from "../src/embeddings.ts";
import { LanguageModel, type CompleteInput, type ModelCompletion } from "../src/llm.ts";
import { StructuredLogger } from "../src/logging.ts";
import { PipelineRunsServiceLive } from "../src/pipeline-runs.ts";
import { RandomBytesLive } from "../src/random.ts";
import { SourceDocumentsServiceLive } from "../src/source-documents.ts";
import { ContentStorage } from "../src/storage.ts";
import { seedLegacySources, versionedSourceStorage } from "./fixtures/source-documents.ts";
import {
  replyHistoryTestDatabaseUrl,
  runHistoryDatabase,
} from "./fixtures/reply-history-database.ts";

const uuid = Schema.decodeUnknownSync(Uuid);
const hex = (n: number) => n.toString(16).padStart(4, "0");
const id = {
  user: uuid("a0000000-0000-4000-8000-000000000001"),
  vault: uuid("a0000000-0000-4000-8000-000000000002"),
  membership: uuid("a0000000-0000-4000-8000-000000000003"),
  run: uuid("a0000000-0000-4000-8000-000000000004"),
  rerun: uuid("a0000000-0000-4000-8000-000000000005"),
  oldTopic: uuid("a0000000-0000-4000-8000-000000000006"),
  oldArticle: uuid("a0000000-0000-4000-8000-000000000007"),
};
const document = (n: number) => uuid(`a0000000-0000-4000-8000-0000000${"1"}${hex(n)}`);
const idea = (n: number) => uuid(`a0000000-0000-4000-8000-0000000${"2"}${hex(n)}`);
const subjects = [
  { name: "Alpha", documents: [1, 2, 3, 4, 5] },
  { name: "Beta", documents: [6, 7, 8, 9, 10] },
];

const dataDir = await mkdtemp(join(tmpdir(), "gm-themes-pipeline-"));
const config: AppConfigShape = {
  databaseUrl: Redacted.make(replyHistoryTestDatabaseUrl),
  jwtSecret: Redacted.make("themes-pipeline-secret"),
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
  reduceModel: "anthropic/claude-sonnet-5.5",
  renderModel: "z-ai/glm-5.3",
  extractTemperature: Option.some(0.2),
  mapTemperature: Option.some(0.3),
  reduceTemperature: Option.none(),
  renderTemperature: Option.some(0.3),
  renderReasoningEffort: Option.some("high"),
  compileEnrichConcurrency: 2,
  compileWriteConcurrency: 2,
  compilePartitionTargetTokens: 100_000,
  compilePartitionMinFactor: 0.3,
  compilePartitionMaxFactor: 1.5,
  compilePremergeJaccardThreshold: 0.8,
  compileDeriveRelatedLimit: 20,
  compilePipeline: "themes",
  pipelineConcurrency: 1,
  goldensRandomSeed: Option.none(),
  goldensClock: Option.none(),
  embeddingModel: "qwen/qwen3-embedding-8b",
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
const sourceStorage = versionedSourceStorage(files);
const StorageLive = Layer.succeed(ContentStorage, {
  ...sourceStorage,
  listMarkdown: (_owner, scope) =>
    Effect.succeed(
      [...files.keys()]
        .filter((path) => path.startsWith(`${scope}/`) && path.endsWith(".md"))
        .filter((path) => scope === "raw" || !path.slice("wiki/".length).includes("/"))
        .sort()
        .map((path) => ({ path, etag: null })),
    ),
  writeText: (_owner, path, content) => Effect.sync(() => void files.set(path, content)),
  deletePath: (_owner, path) => Effect.sync(() => void files.delete(path)),
  clear: () => Effect.void,
});

const calls: CompleteInput[] = [];
const contentOf = (input: CompleteInput) => String(input.messages[0]?.content);
const reply = (input: CompleteInput): string => {
  const content = contentOf(input);
  if (content.startsWith("You are proposing thematic topics")) {
    const name = /## Doc: (\w+)/.exec(content)?.[1] ?? "";
    return JSON.stringify({
      topics: [
        {
          slug: name.toLowerCase(),
          title: name,
          description: `About ${name}.`,
          inclusion_test: `It is about ${name}.`,
          subsumed_idea_ids: [...content.matchAll(/^- (idea_\d+) /gm)].map((match) => match[1]),
        },
      ],
      set_aside: [],
    });
  }
  if (content.startsWith("You are comparing two topics"))
    return JSON.stringify({ relation: "same", reason: "Same subject." });
  if (content.startsWith("You are comparing two themes"))
    return JSON.stringify({ relation: "related", reason: "Different subjects." });
  if (content.startsWith("You are organizing a wiki"))
    return JSON.stringify({ verdict: "yes", reason: "Fits." });
  if (content.startsWith("You are writing a wiki article")) {
    const title = /^Title: (.*)$/m.exec(content)?.[1] ?? "";
    const body =
      title === "Alpha"
        ? "# Alpha\n\nAlpha grew beside the Beta movement [^1]."
        : `# ${title}\n\n${title} stood alone [^1].`;
    return JSON.stringify({ body, tags: [title] });
  }
  if (content.startsWith("Below is an article"))
    return JSON.stringify({
      mentions: content.includes("the Beta movement")
        ? [{ phrase: "the Beta movement", about: "the Beta subject" }]
        : [],
    });
  if (content.startsWith("A wiki article mentions")) return JSON.stringify({ choice: 1 });
  if (content.startsWith("A wiki article links")) return JSON.stringify({ verdict: "yes" });
  throw new Error(`unexpected compile call: ${content.slice(0, 80)}`);
};
const LanguageModelLive = Layer.succeed(LanguageModel, {
  hasApiKey: true,
  streamChat: () => Stream.empty,
  complete: (input) =>
    Effect.sync((): ModelCompletion => {
      calls.push(input);
      return {
        text: reply(input),
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.001 },
      };
    }),
});
const axis = (text: string) => (/beta/i.test(text) ? 1 : /alpha/i.test(text) ? 0 : 2);
const EmbeddingsLive = Layer.succeed(EmbeddingsService, {
  embed: (texts) =>
    Effect.succeed(
      texts.map((text) =>
        Array.from({ length: 1024 }, (_unused, index) => (index === axis(text) ? 1 : 0)),
      ),
    ),
});
const LoggerLive = Layer.succeed(StructuredLogger, {
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
});
const BaseLive = Layer.mergeAll(
  DatabaseLive.pipe(
    Layer.provide(PgClientLive),
    Layer.provideMerge(Layer.succeed(AppConfig, config)),
  ),
  ClockLive,
  RandomBytesLive,
);
const PipelineLive = PipelineRunsServiceLive.pipe(Layer.provideMerge(BaseLive));
const TestLive = CompilePhasesLive.pipe(
  Layer.provideMerge(LanguageModelLive),
  Layer.provideMerge(EmbeddingsLive),
  Layer.provideMerge(
    SourceDocumentsServiceLive.pipe(Layer.provideMerge(StorageLive), Layer.provideMerge(BaseLive)),
  ),
  Layer.provideMerge(PipelineLive),
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(LoggerLive),
  Layer.provideMerge(BaseLive),
);
const run = <A>(effect: Effect.Effect<A, unknown, Database | CompilePhases>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestLive)));

const compile = (runId: Uuid) =>
  run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) =>
        d.insert(pipelineRuns).values({
          id: runId,
          vaultId: id.vault,
          trigger: "manual",
          status: "running",
          currentPhase: "",
          phaseStatus: "",
          progressSteps: [],
        }),
      );
      const phases = yield* CompilePhases;
      const validated = yield* phases.abstract(id.vault, runId);
      yield* phases.derive(id.vault, runId, validated);
      yield* phases.render(id.vault, runId, validated);
      yield* phases.verify(id.vault, runId);
      return validated;
    }),
  );

const rows = () =>
  run(
    Effect.gen(function* () {
      const db = yield* Database;
      return {
        topics: yield* db.query((d) =>
          d
            .select({ id: topics.topicId, slug: topics.slug, status: topics.articleStatus })
            .from(topics),
        ),
        links: yield* db.query((d) => d.select().from(topicLinks)),
        backlinks: yield* db.query((d) => d.select().from(backlinks)),
        memberships: yield* db.query((d) => d.select().from(topicMembership)),
        articles: yield* db.query((d) =>
          d
            .select({ topicId: wikiArticles.topicId, path: wikiArticles.filePath })
            .from(wikiArticles),
        ),
      };
    }),
  );

describe("the themes Update pipeline", () => {
  beforeAll(() => runHistoryDatabase(Effect.void));
  afterAll(() => rm(dataDir, { recursive: true, force: true }));

  beforeEach(async () => {
    calls.length = 0;
    files.clear();
    files.set("wiki/old-topic.md", "---\ntopic_id: old\n---\n# Old topic\n");
    files.set("config.yaml", 'thematic_hint: "Food bank operations, plans and people"\n');
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d.delete(users));
        yield* db.query((d) =>
          d.insert(users).values({ id: id.user, email: "themes@example.com" }),
        );
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert(vaults).values({ id: id.vault, name: "Themes", ownerId: id.user });
            yield* tx
              .insert(vaultMemberships)
              .values({ id: id.membership, vaultId: id.vault, userId: id.user, role: "EDITOR" });
            for (const subject of subjects)
              for (const n of subject.documents) {
                yield* seedLegacySources(tx, {
                  id: document(n),
                  vaultId: id.vault,
                  filePath: `raw/${subject.name.toLowerCase()}-${n}.md`,
                  fileHash: `file-${n}`,
                  bodyHash: `body-${n}`,
                  sourceType: "document",
                  title: `${subject.name} source ${n}`,
                  publishedDate: "1910",
                });
                yield* tx.insert(ideas).values({
                  ideaId: idea(n),
                  vaultId: id.vault,
                  documentId: document(n),
                  kind: "concept",
                  label: `${subject.name} idea ${n}`,
                  description: `Part of ${subject.name}`,
                });
                yield* tx.insert(anchors).values({
                  ideaId: idea(n),
                  position: 0,
                  claim: `${subject.name} claim ${n}`,
                  quote: `${subject.name} quote ${n}`,
                  chunkIndex: n,
                });
              }
            yield* tx.insert(topics).values({
              topicId: id.oldTopic,
              vaultId: id.vault,
              slug: "old-topic",
              title: "Old topic",
              description: "From the previous pipeline.",
              articleStatus: "rendered",
            });
            yield* tx.insert(wikiArticles).values({
              id: id.oldArticle,
              vaultId: id.vault,
              topicId: id.oldTopic,
              filePath: "wiki/old-topic.md",
              fileHash: "old",
              bodyHash: "old",
              title: "Old topic",
              precis: "From the previous pipeline.",
            });
          }),
        );
      }),
    );
  });

  it("builds, writes and links the articles, and archives the old library's articles", async () => {
    const validated = await compile(id.run);
    expect(validated.map((topic) => topic.slug).toSorted()).toEqual(["alpha", "beta"]);
    const alpha = validated.find((topic) => topic.slug === "alpha");
    const beta = validated.find((topic) => topic.slug === "beta");
    expect(alpha?.subsumedIdeaIds).toHaveLength(5);
    const alphaFile = files.get("wiki/alpha.md") ?? "";
    expect(alphaFile).toContain("Alpha grew beside [the Beta movement](wiki/beta.md) [^1].");
    expect(alphaFile).toMatch(
      /\[\^1\]: \[Alpha source \d+ \(1910\)\]\(raw\/alpha-\d+\.md#\^p\d+\) — "Alpha quote \d+"/,
    );
    expect(files.has("wiki/old-topic.md")).toBe(false);
    expect(files.has(`archive/${id.oldTopic}/old-topic.md`)).toBe(true);
    const state = await rows();
    expect(state.topics.find((topic) => topic.id === id.oldTopic)?.status).toBe("archived");
    expect(state.topics.filter((topic) => topic.status === "rendered")).toHaveLength(2);
    expect(state.links).toEqual([{ sourceTopicId: alpha?.topicId, targetTopicId: beta?.topicId }]);
    expect(state.backlinks).toHaveLength(1);
    expect(state.memberships).toHaveLength(10);
    const checks = calls.filter((call) => contentOf(call).startsWith("A wiki article links"));
    expect(checks.map((call) => [call.model, call.temperature])).toEqual([
      ["anthropic/claude-sonnet-5.5", undefined],
    ]);
    const focused = calls.filter((call) =>
      contentOf(call).includes("Its editorial focus: Food bank operations, plans and people."),
    );
    expect(focused.length).toBeGreaterThan(0);
    expect(calls.some((call) => contentOf(call).includes("{vault_focus}"))).toBe(false);
    const writes = calls.filter((call) => contentOf(call).startsWith("You are writing"));
    expect(
      writes.every((call) => call.reasoningEffort === "high" && call.temperature === 0.3),
    ).toBe(true);
  });

  it("asks nothing again and keeps the same articles when nothing changed", async () => {
    const first = await compile(id.run);
    const before = new Map(files);
    calls.length = 0;
    const again = await compile(id.rerun);
    expect(calls).toHaveLength(0);
    expect(again).toEqual(first);
    expect(files.get("wiki/alpha.md")).toBe(before.get("wiki/alpha.md"));
    expect(files.get("wiki/beta.md")).toBe(before.get("wiki/beta.md"));
  });
});
