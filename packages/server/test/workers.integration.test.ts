import {
  compileIntents,
  Database,
  pipelineRuns,
  sourceDocuments,
  tasks,
  users,
  vaultMemberships,
  vaults,
} from "@great-minds/database";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as PgClient from "@effect/sql-pg/PgClient";
import type { FileFingerprint, Uuid } from "@great-minds/domain";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, Option, Redacted } from "effect";
import type * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CompileIntentReconciler,
  CompileIntentReconcilerLive,
  CompileWorkflow,
  CompileWorkflowLive,
} from "../src/compile-intents.ts";
import { phaseFailure, RENDER_STEP_LABELS } from "../src/compile-contract.ts";
import { CompilePhases, CompilePhasesLive } from "../src/compile-phases.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { ClockLive } from "../src/clock.ts";
import { stagedFileToMarkdown } from "../src/conversion.ts";
import { rawFileHash } from "../src/crypto.ts";
import { DrizzleLive } from "../src/db.ts";
import { EmbeddingsService } from "../src/embeddings.ts";
import { JobsService, JobsServiceLive } from "../src/jobs.ts";
import { LanguageModel } from "../src/llm.ts";
import { StructuredLogger } from "../src/logging.ts";
import {
  PipelineRunsService,
  PipelineRunsServiceLive,
  progressSteps,
} from "../src/pipeline-runs.ts";
import { RandomBytesLive } from "../src/random.ts";
import { sourceIdForKey } from "../src/source-identity.ts";
import { SourceDocumentsServiceLive } from "../src/source-documents.ts";
import {
  StagedFileIngestWorkflow,
  StagedFileIngestWorkflowLive,
} from "../src/staged-file-ingest-workflow.ts";
import { ContentStorage, StagedStorage, StorageFileMissing } from "../src/storage.ts";
import { VaultAccessServiceLive } from "../src/vaults.ts";
import { WorkflowEngineLive } from "../src/workflow-engine.ts";

const id = {
  user: "10000000-0000-4000-8000-000000000001" as Uuid,
  vault: "10000000-0000-4000-8000-000000000002" as Uuid,
  ingestRun: "10000000-0000-4000-8000-000000000003" as Uuid,
  compileIntent: "10000000-0000-4000-8000-000000000004" as Uuid,
  dedupeRun: "10000000-0000-4000-8000-000000000005" as Uuid,
  isolationRun: "10000000-0000-4000-8000-000000000006" as Uuid,
  queuedRun: "10000000-0000-4000-8000-000000000007" as Uuid,
  queuedIntent: "10000000-0000-4000-8000-000000000008" as Uuid,
  terminalRun: "10000000-0000-4000-8000-000000000009" as Uuid,
  terminalIntent: "10000000-0000-4000-8000-000000000010" as Uuid,
  zombieRun: "10000000-0000-4000-8000-000000000011" as Uuid,
  resumeRun: "10000000-0000-4000-8000-000000000012" as Uuid,
  renderFailureIntent: "10000000-0000-4000-8000-000000000013" as Uuid,
  renderFailureRun: "10000000-0000-4000-8000-000000000014" as Uuid,
  cancelIngestRun: "10000000-0000-4000-8000-000000000016" as Uuid,
  stagedFailureRun: "10000000-0000-4000-8000-000000000018" as Uuid,
  maskedCompileRun: "10000000-0000-4000-8000-000000000019" as Uuid,
  maskedCompileIntent: "10000000-0000-4000-8000-000000000020" as Uuid,
} as const;

const resumeRunnerPath = fileURLToPath(
  new URL("./fixtures/staged-ingest-resume-runner.ts", import.meta.url),
);

const docxBase64 =
  "UEsDBBQAAAAIAJdr7FzMVIwQ4AAAAJwBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2Qy07DMBBFf8XyFsUTukAIJekCyhJYlA+w7Eli4Zc8bil/z6QtXaDC0r6PM7rd+hC82GMhl2Ivb1UrBUaTrItTL9+3z829XA/d9isjCbZG6uVca34AIDNj0KRSxsjKmErQlZ9lgqzNh54QVm17BybFirE2demQQ/eEo975KjYH/j5hC3qS4vFkXFi91Dl7Z3RlHfbR/qI0Z4Li5NFDs8t0wwYJVwmL8jfgnHvlHYqzKN50qS86sAs+U7Fgk9kFTqr/a67cmcbRGbzkl7ZckkEiHjh4dVGCdvHnfjjOPXwDUEsDBBQAAAAIAJdr7Fw2V97cogAAABgBAAALAAAAX3JlbHMvLnJlbHONzzsOwjAMBuCrRN6pCwNCqGkXhNQVlQNEiZtGNA8l4XV7MjBQxMBo+/dnuekedmY3isl4x2Fd1cDISa+M0xzOw3G1g65tTjSLXBJpMiGxsuIShynnsEdMciIrUuUDuTIZfbQilzJqDEJehCbc1PUW46cBS5P1ikPs1RrY8Az0j+3H0Ug6eHm15PKPE1+JIouoKXO4+6hQvdtVYQHbBhcvti9QSwMEFAAAAAgAl2vsXFw+jciZAAAAzwAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEWOSQ7CMAxFrxJlT1NYIFR12CBOAAfIRBupsSMnpfT2JEWIzbOsbz3/dnj7mb0sRYfQ8WNVc2ZBo3Ewdvxxvx0ufOjbtTGoF28hsXwPsVk7PqUUGiGinqyXscJgIWdPJC9TXmkUK5IJhNrGmHV+Fqe6PgsvHfCiVGi2MkMBFaT+upBUs2XKgaSN/b62ooSFtDPs/ArEv1z/AVBLAQIUAxQAAAAIAJdr7FzMVIwQ4AAAAJwBAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgAl2vsXDZX3tyiAAAAGAEAAAsAAAAAAAAAAAAAAIABEQEAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgAl2vsXFw+jciZAAAAzwAAABEAAAAAAAAAAAAAAIAB3AEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAAKQCAAAAAA==";

const databaseUrl = () => {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
  return value;
};

const JournalSqlLive = PgClient.layer({ url: Redacted.make(databaseUrl()) });

const resetJournal = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`DROP TABLE IF EXISTS cluster_messages, cluster_replies, cluster_migrations CASCADE`;
    }).pipe(Effect.provide(JournalSqlLive)),
  );

const config: AppConfigShape = {
  databaseUrl: Redacted.make(databaseUrl()),
  jwtSecret: Redacted.make("worker-test-secret"),
  jwtAccessExpiryMinutes: 30,
  jwtRefreshExpiryDays: 7,
  authCodeExpiryMinutes: 10,
  webauthnRpId: "localhost",
  webauthnOrigins: ["http://localhost:5173"],
  webauthnRpName: "Great Minds",
  resendApiKey: Option.none(),
  resendFromEmail: Option.none(),
  dataDir: "/tmp/gm-worker-test",
  storageBackend: "r2",
  r2AccountId: Option.some("test"),
  r2AccessKeyId: Option.some(Redacted.make("test")),
  r2SecretAccessKey: Option.some(Redacted.make("test")),
  r2BucketName: Option.none(),
  openRouterApiKey: Option.none(),
  openRouterApiUrl: "https://openrouter.ai/api/v1",
  parallelApiKey: Option.none(),
  parallelSearchUrl: "https://api.parallel.ai/v1beta/search",
  queryModel: "test",
  queryFallbackModels: ["test"],
  extractModel: "test",
  mapModel: "test",
  reduceModel: "test",
  renderModel: "test",
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
  embeddingModel: "test",
  corsOrigins: [],
  suppressAuth: false,
  allowPrivateUrlFetch: false,
  serverHost: "127.0.0.1",
  serverPort: 0,
};

const staged = new Map<FileFingerprint, Uint8Array>();
const written = new Map<string, string>();
const deleted: FileFingerprint[] = [];
const readDefects = new Set<FileFingerprint>();
const deleteDefects = new Set<FileFingerprint>();
const writeDefects = new Set<string>();
const logEvents: { readonly event: string; readonly fields: Record<string, unknown> }[] = [];

const stageBytes = (bytes: Uint8Array) => {
  const hash = rawFileHash(bytes);
  staged.set(hash, bytes);
  return hash;
};

const testFingerprint = (character: string) =>
  character.repeat(64) as FileFingerprint;

let readPause:
  | {
      readonly hash: FileFingerprint;
      readonly started: Promise<void>;
      readonly signalStarted: () => void;
      readonly released: Promise<void>;
      readonly release: () => void;
    }
  | undefined;

const pauseStagedRead = (hash: FileFingerprint) => {
  let signalStarted = () => {};
  let release = () => {};
  const pause = {
    hash,
    started: new Promise<void>((resolve) => {
      signalStarted = resolve;
    }),
    signalStarted: () => signalStarted(),
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
  readPause = pause;
  return pause;
};

const TestLoggerLive = Layer.succeed(StructuredLogger, {
  info: (event, fields) => Effect.sync(() => logEvents.push({ event, fields })),
  warn: (event, fields) => Effect.sync(() => logEvents.push({ event, fields })),
  error: (event, fields) => Effect.sync(() => logEvents.push({ event, fields })),
});

const StorageLive = Layer.succeed(ContentStorage, {
  listMarkdown: () => Effect.succeed([]),
  readText: (_vaultId, path) => {
    const content = written.get(path);
    return content === undefined
      ? Effect.fail(new StorageFileMissing({ path }))
      : Effect.succeed(content);
  },
  writeText: (_vaultId, path, content) =>
    writeDefects.has(path)
      ? Effect.die({ _tag: "R2WriteDefect", detail: `write rejected for ${path}` })
      : Effect.sync(() => written.set(path, content)).pipe(Effect.asVoid),
  appendText: () => Effect.die("unused"),
  exists: () => Effect.succeed(false),
  deletePath: () => Effect.void,
  clear: () => Effect.void,
});

const StagedStorageLive = Layer.succeed(StagedStorage, {
  pruneExpiredStaged: () => Effect.void,
  prepareStagedPut: () =>
    Effect.succeed({ transport: "presigned" as const, url: "https://example.invalid" }),
  writeStagedBytes: (_vaultId, hash, bytes) =>
    Effect.sync(() => staged.set(hash, bytes)).pipe(Effect.asVoid),
  readStagedBytes: (_vaultId, hash) => {
    if (readPause?.hash === hash) {
      const pause = readPause;
      pause.signalStarted();
      return Effect.promise(async () => {
        await pause.released;
        const bytes = staged.get(hash);
        if (bytes === undefined) throw new Error(`missing staged object ${hash}`);
        return bytes;
      });
    }
    if (readDefects.has(hash)) {
      const error = new Error(`read exploded for ${hash}`);
      error.name = "ReadStorageDefect";
      return Effect.die(error);
    }
    const bytes = staged.get(hash);
    return bytes === undefined
      ? Effect.die(new Error(`missing staged object ${hash}`))
      : Effect.succeed(bytes);
  },
  deleteStaged: (_vaultId, hash) => {
    if (deleteDefects.has(hash)) {
      const error = new Error(`delete exploded for ${hash}`);
      error.name = "DeleteStorageDefect";
      return Effect.die(error);
    }
    return Effect.sync(() => deleted.push(hash)).pipe(Effect.asVoid);
  },
  clearStaged: () => Effect.void,
});

const ConfigLive = Layer.succeed(AppConfig, config);
const BaseLive = Layer.mergeAll(
  DrizzleLive.pipe(Layer.provideMerge(ConfigLive)),
  TestLoggerLive,
  ClockLive,
  RandomBytesLive,
);
const PipelineLive = PipelineRunsServiceLive.pipe(Layer.provideMerge(BaseLive));
const VaultAccessLive = VaultAccessServiceLive.pipe(Layer.provideMerge(BaseLive));
const EmbeddingsLive = Layer.succeed(EmbeddingsService, { embed: async () => [] });
const LanguageModelLive = Layer.succeed(LanguageModel, {
  hasApiKey: true,
  streamChat: async function* () {},
  complete: async () => {
    throw new Error("unexpected compile LLM call");
  },
});
const CompilePhasesLiveLayer = CompilePhasesLive.pipe(
  Layer.provideMerge(LanguageModelLive),
  Layer.provideMerge(EmbeddingsLive),
  Layer.provideMerge(PipelineLive),
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(BaseLive),
);
const SourceDocumentsLive = SourceDocumentsServiceLive.pipe(
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(BaseLive),
);
const EngineLive = WorkflowEngineLive.pipe(Layer.provideMerge(BaseLive));
const WorkflowHandlersLive = Layer.mergeAll(StagedFileIngestWorkflowLive, CompileWorkflowLive).pipe(
  Layer.provideMerge(SourceDocumentsLive),
  Layer.provideMerge(CompilePhasesLiveLayer),
  Layer.provideMerge(PipelineLive),
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(StagedStorageLive),
  Layer.provideMerge(EngineLive),
  Layer.provideMerge(BaseLive),
);
const WorkflowsLive = WorkflowHandlersLive.pipe(Layer.provideMerge(EngineLive));
const ReconcilerLive = CompileIntentReconcilerLive.pipe(
  Layer.provideMerge(PipelineLive),
  Layer.provideMerge(WorkflowsLive),
  Layer.provideMerge(BaseLive),
);
const JobsLive = JobsServiceLive.pipe(
  Layer.provideMerge(PipelineLive),
  Layer.provideMerge(VaultAccessLive),
  Layer.provideMerge(BaseLive),
);
const TestLive = Layer.mergeAll(ReconcilerLive, JobsLive).pipe(
  Layer.provideMerge(WorkflowsLive),
  Layer.provideMerge(PipelineLive),
  Layer.provideMerge(SourceDocumentsLive),
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(StagedStorageLive),
  Layer.provideMerge(BaseLive),
);

const RenderFailurePhasesLive = Layer.effect(
  CompilePhases,
  Effect.gen(function* () {
    const pipeline = yield* PipelineRunsService;
    return {
      archiveTransitions: () => Effect.void,
      ingest: () => Effect.void,
      extract: () => Effect.void,
      abstract: () =>
        Effect.succeed([
          {
            topicId: "10000000-0000-4000-8000-000000000015",
            slug: "render-failure",
            title: "Render failure",
            description: "Pins the last emitted render progress snapshot.",
            subsumedIdeaIds: [],
            linkTargets: [],
          },
        ]),
      derive: () => Effect.void,
      render: (_vaultId, runId) =>
        Effect.gen(function* () {
          yield* pipeline.updateProgress(
            runId,
            "render",
            "progress",
            progressSteps(RENDER_STEP_LABELS, "write_articles", {
              completed: new Set(["plan_articles"]),
              counts: { plan_articles: [1, 1], write_articles: [0, 1] },
            }),
          );
          return yield* Effect.die(new Error("forced render seam"));
        }),
      verify: () => Effect.die("verify unexpectedly reached"),
      publish: () => Effect.die("publish unexpectedly reached"),
    };
  }),
);
const RenderFailureHandlersLive = CompileWorkflowLive.pipe(
  Layer.provideMerge(RenderFailurePhasesLive),
  Layer.provideMerge(PipelineLive),
  Layer.provideMerge(EngineLive),
  Layer.provideMerge(BaseLive),
);
const RenderFailureLive = Layer.mergeAll(
  RenderFailureHandlersLive.pipe(Layer.provideMerge(EngineLive)),
  PipelineLive,
  BaseLive,
);

const run = <A>(
  effect: Effect.Effect<
    A,
    unknown,
    | Database
    | CompileIntentReconciler
    | JobsService
    | PipelineRunsService
    | WorkflowEngine.WorkflowEngine
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(TestLive)));

const reconcileUntilSatisfied = (
  reconciler: CompileIntentReconciler["Service"],
  timeoutMs = 5_000,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = yield* reconciler.reconcileOnce();
      if (result.satisfied > 0) {
        return result;
      }
      yield* Effect.sleep("25 millis");
    }
    throw new Error(`compile intent was not satisfied within ${timeoutMs}ms`);
  });

const startResumeRunner = (
  mode: "pause" | "resume",
  runId: Uuid,
  hash: FileFingerprint,
) =>
  spawn(
    process.execPath,
    ["--experimental-strip-types", resumeRunnerPath, mode, id.vault, runId, hash],
    {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: { ...process.env, DATABASE_URL: databaseUrl() },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

const waitForRunnerOutput = (
  child: ReturnType<typeof startResumeRunner>,
  marker: string,
  timeoutMs = 20_000,
) =>
  new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out waiting for ${marker}. Output:\n${output}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(marker)) {
        clearTimeout(timeout);
        resolve(output);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Runner exited (${String(code)}/${String(signal)}). Output:\n${output}`));
    });
  });

const waitForRunnerExit = (child: ReturnType<typeof startResumeRunner>, timeoutMs = 20_000) =>
  new Promise<{ readonly output: string; readonly code: number | null }>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Runner did not exit. Output:\n${output}`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ output, code });
    });
  });

const seed = () =>
  run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d.delete(users)).pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(users)
        .values({ id: id.user, email: "worker@example.com" }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(vaults)
        .values({
          id: id.vault,
          name: "Worker Vault",
          ownerId: id.user,
        }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(vaultMemberships)
        .values({
          id: "10000000-0000-4000-8000-000000000017",
          vaultId: id.vault,
          userId: id.user,
          role: "OWNER",
        }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(pipelineRuns)
        .values({
          id: id.ingestRun,
          vaultId: id.vault,
          trigger: "staged_files",
          status: "pending",
          currentPhase: "",
          phaseStatus: "",
          progressSteps: [],
        }))
        .pipe(Effect.orDie);
    }),
  );

describe("M4.2 durable workers", () => {
  beforeEach(async () => {
    await resetJournal();
    staged.clear();
    written.clear();
    deleted.length = 0;
    readDefects.clear();
    deleteDefects.clear();
    writeDefects.clear();
    readPause = undefined;
    logEvents.length = 0;
    await seed();
  });

  it("decodes CSV, JSON, and XML staged files as UTF-8 text", async () => {
    await expect(
      stagedFileToMarkdown(Buffer.from("name,value\nalpha,1"), "data.csv", "text/csv"),
    ).resolves.toBe("name,value\nalpha,1");
    await expect(
      stagedFileToMarkdown(Buffer.from('{"alpha":1}'), "data.json", "application/json"),
    ).resolves.toBe('{"alpha":1}');
    await expect(
      stagedFileToMarkdown(Buffer.from("<alpha>1</alpha>"), "data.xml", "application/xml"),
    ).resolves.toBe("<alpha>1</alpha>");
  });

  it("maps timeout and non-Error defects to descriptive compile failures", async () => {
    const timeout = await Effect.runPromise(
      Effect.result(Effect.never.pipe(Effect.timeout("1 millis"))),
    );
    expect(timeout._tag).toBe("Failure");
    if (timeout._tag === "Failure") {
      expect(phaseFailure("ingest", timeout.failure)).toMatchObject({
        errorType: "TimeoutError",
        message: "Operation timed out",
      });
    }
    expect(
      phaseFailure("ingest", {
        _tag: "R2ListDefect",
        message: undefined,
        detail: "list request stalled",
      }),
    ).toMatchObject({
      errorType: "R2ListDefect",
      message: "list request stalled",
    });
  });

  it("cancels a mid-flight staged ingest workflow before it can write documents", async () => {
    const hash = stageBytes(Buffer.from("# Must not persist\n\nCancellation wins."));
    const pause = pauseStagedRead(hash);

    const state = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: id.cancelIngestRun,
            vaultId: id.vault,
            trigger: "staged_files",
            status: "running",
            currentPhase: "source_ingest",
            phaseStatus: "started",
            progressSteps: [],
            activeTaskId: id.cancelIngestRun,
            activeTaskType: "staged_file_ingest",
          }))
          .pipe(Effect.orDie);
        yield* StagedFileIngestWorkflow.execute(
          {
            vaultId: id.vault,
            pipelineRunId: id.cancelIngestRun,
            files: [
              {
                name: "cancel.md",
                size: staged.get(hash)!.length,
                hash,
                mimetype: "text/markdown",
              },
            ],
          },
          { discard: true },
        );
        yield* Effect.promise(() => pause.started);
        const jobs = yield* JobsService;
        yield* jobs.cancelCompile(id.user, id.vault, id.cancelIngestRun);
        yield* Effect.sleep("250 millis");
        yield* Effect.sync(pause.release);
        yield* Effect.sleep("100 millis");
        return {
          run: (yield* db.query((d) => d
            .select()
            .from(pipelineRuns)
            .where(eq(pipelineRuns.id, id.cancelIngestRun)))
            .pipe(Effect.orDie))[0],
          documents: yield* db.query((d) => d
            .select()
            .from(sourceDocuments)
            .where(eq(sourceDocuments.vaultId, id.vault)))
            .pipe(Effect.orDie),
        };
      }),
    );

    expect(state.run).toMatchObject({ status: "cancelled", phaseStatus: "failed" });
    expect(state.documents).toHaveLength(0);
    expect(written.size).toBe(0);
  }, 30_000);

  it("persists valid staged files but fails the batch visibly when another file cannot convert", async () => {
    const docxHash = stageBytes(Buffer.from(docxBase64, "base64"));
    const textHash = stageBytes(Buffer.from("# Durable text\n\nWorker content."));
    const badHash = stageBytes(Buffer.from([0, 1, 2]));

    const result = await run(
      StagedFileIngestWorkflow.execute({
        vaultId: id.vault,
        pipelineRunId: id.ingestRun,
        files: [
          {
            name: "binary.docx",
            size: staged.get(docxHash)!.length,
            hash: docxHash,
            mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
          {
            name: "notes.md",
            size: staged.get(textHash)!.length,
            hash: textHash,
            mimetype: "text/markdown",
          },
          { name: "bad.bin", size: 3, hash: badHash, mimetype: "application/octet-stream" },
        ],
      }),
    );
    expect(result).toEqual({ ingested: 2, skipped: 0, failed: 1 });
    const docxSourceId = sourceIdForKey(id.vault, `upload:${docxHash}`);
    expect(written.get(`raw/docs/${docxSourceId}.md`)).toContain(
      "Durable binary document",
    );
    expect(deleted.sort()).toEqual([badHash, docxHash, textHash].sort());

    const rows = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return {
          documents: yield* db.query((d) => d.select().from(sourceDocuments)).pipe(Effect.orDie),
          intents: yield* db.query((d) => d.select().from(compileIntents)).pipe(Effect.orDie),
          pipeline: yield* db.query((d) => d
            .select()
            .from(pipelineRuns)
            .where(eq(pipelineRuns.id, id.ingestRun)))
            .pipe(Effect.orDie),
        };
      }),
    );
    expect(rows.documents).toHaveLength(2);
    expect(rows.intents).toHaveLength(0);
    expect(rows.pipeline[0]).toMatchObject({
      currentPhase: "source_ingest",
      phaseStatus: "failed",
      status: "failed",
      error: "1 of 3 files could not be ingested",
      compileIntentId: null,
    });
    expect(rows.pipeline[0]?.progressSteps).toContainEqual(
      expect.objectContaining({
        key: "read_files",
        status: "failed",
        detail: expect.stringContaining("bad.bin"),
      }),
    );

    const dedupe = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: id.dedupeRun,
            vaultId: id.vault,
            trigger: "staged_files",
            status: "pending",
            currentPhase: "",
            phaseStatus: "",
            progressSteps: [],
          }))
          .pipe(Effect.orDie);
        return yield* StagedFileIngestWorkflow.execute({
          vaultId: id.vault,
          pipelineRunId: id.dedupeRun,
          files: [
            {
              name: "binary.docx",
              size: staged.get(docxHash)!.length,
              hash: docxHash,
              mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            },
            {
              name: "notes.md",
              size: staged.get(textHash)!.length,
              hash: textHash,
              mimetype: "text/markdown",
            },
          ],
        });
      }),
    );
    expect(dedupe).toEqual({ ingested: 0, skipped: 2, failed: 0 });
    const dedupeState = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return {
          intents: yield* db.query((d) => d.select().from(compileIntents)).pipe(Effect.orDie),
          run: yield* db.query((d) => d
            .select()
            .from(pipelineRuns)
            .where(eq(pipelineRuns.id, id.dedupeRun)))
            .pipe(Effect.orDie),
        };
      }),
    );
    expect(dedupeState.intents).toHaveLength(0);
    expect(dedupeState.run[0]).toMatchObject({ status: "completed", currentPhase: "publish" });
  }, 30_000);

  it("persists per-file failure details and does not compile a partial staged batch", async () => {
    const readFailureHash = testFingerprint("d");
    const cleanupFailureHash = stageBytes(
      Buffer.from("# Cleanup survives\n\nPersist this source."),
    );
    readDefects.add(readFailureHash);
    deleteDefects.add(cleanupFailureHash);

    const result = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: id.isolationRun,
            vaultId: id.vault,
            trigger: "staged_files",
            status: "pending",
            currentPhase: "",
            phaseStatus: "",
            progressSteps: [],
          }))
          .pipe(Effect.orDie);
        return yield* StagedFileIngestWorkflow.execute({
          vaultId: id.vault,
          pipelineRunId: id.isolationRun,
          files: [
            {
              name: "missing.md",
              size: 1,
              hash: readFailureHash,
              mimetype: "text/markdown",
            },
            {
              name: "cleanup.md",
              size: staged.get(cleanupFailureHash)!.length,
              hash: cleanupFailureHash,
              mimetype: "text/markdown",
            },
          ],
        });
      }),
    );

    expect(result).toEqual({ ingested: 1, skipped: 0, failed: 1 });
    expect(logEvents).toContainEqual({
      event: "staged_file_ingest.fetch_failed",
      fields: expect.objectContaining({
        file_name: "missing.md",
        error: "ReadStorageDefect",
      }),
    });
    expect(logEvents).toContainEqual({
      event: "staged_file_ingest.cleanup_failures",
      fields: expect.objectContaining({ failed: 1, total: 2 }),
    });

    const state = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return {
          documents: yield* db.query((d) => d
            .select()
            .from(sourceDocuments)
            .where(eq(sourceDocuments.vaultId, id.vault)))
            .pipe(Effect.orDie),
          intents: yield* db.query((d) => d
            .select()
            .from(compileIntents)
            .where(eq(compileIntents.pipelineRunId, id.isolationRun)))
            .pipe(Effect.orDie),
          run: yield* db.query((d) => d
            .select()
            .from(pipelineRuns)
            .where(eq(pipelineRuns.id, id.isolationRun)))
            .pipe(Effect.orDie),
        };
      }),
    );
    expect(state.documents).toHaveLength(1);
    expect(state.intents).toHaveLength(0);
    expect(state.run[0]).toMatchObject({
      status: "failed",
      phaseStatus: "failed",
      error: "1 of 2 files could not be ingested",
      compileIntentId: null,
    });
    expect(state.run[0]?.progressSteps).toContainEqual(
      expect.objectContaining({
        key: "read_files",
        status: "failed",
        detail: expect.stringContaining("missing.md"),
      }),
    );
  }, 30_000);

  it("logs and persists a descriptive staged terminal failure for a non-Error defect", async () => {
    const hash = stageBytes(
      Buffer.from("# Defective write\n\nThe failure must stay observable."),
    );
    const sourceId = sourceIdForKey(id.vault, `upload:${hash}`);
    const path = `raw/docs/${sourceId}.md`;
    writeDefects.add(path);

    const result = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: id.stagedFailureRun,
            vaultId: id.vault,
            trigger: "staged_files",
            status: "pending",
            currentPhase: "",
            phaseStatus: "",
            progressSteps: [],
          }))
          .pipe(Effect.orDie);
        return yield* Effect.exit(
          StagedFileIngestWorkflow.execute({
            vaultId: id.vault,
            pipelineRunId: id.stagedFailureRun,
            files: [
              {
                name: "defect.md",
                size: staged.get(hash)!.length,
                hash,
                mimetype: "text/markdown",
              },
            ],
          }),
        );
      }),
    );
    expect(result._tag).toBe("Failure");
    expect(logEvents).toContainEqual({
      event: "staged_file_ingest.failed",
      fields: expect.objectContaining({
        pipeline_run_id: id.stagedFailureRun,
        step: "persist",
        error_type: "R2WriteDefect",
        error_message: `write rejected for ${path}`,
      }),
    });

    const state = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select()
          .from(pipelineRuns)
          .where(eq(pipelineRuns.id, id.stagedFailureRun)))
          .pipe(Effect.orDie);
      }),
    );
    expect(state[0]).toMatchObject({
      status: "failed",
      currentPhase: "source_ingest",
      phaseStatus: "failed",
      error: `R2WriteDefect: write rejected for ${path}`,
    });
    expect(state[0]?.error).not.toBe("undefined");
  }, 30_000);

  it("resume-after-persist preserves the journaled ingest decision and creates the intent", async () => {
    const hash = testFingerprint("f");
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: id.resumeRun,
            vaultId: id.vault,
            trigger: "staged_files",
            status: "pending",
            currentPhase: "",
            phaseStatus: "",
            progressSteps: [],
          }))
          .pipe(Effect.orDie);
      }),
    );

    const first = startResumeRunner("pause", id.resumeRun, hash);
    await waitForRunnerOutput(first, "STAGED persist journaled");
    const liveRecovered = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .update(pipelineRuns)
          .set({
            status: "running",
            activeTaskId: id.resumeRun,
            activeTaskType: "staged_file_ingest",
            updatedAt: new Date(0),
          })
          .where(eq(pipelineRuns.id, id.resumeRun)))
          .pipe(Effect.orDie);
        const pipeline = yield* PipelineRunsService;
        return yield* pipeline.recoverZombies(new Date(Date.now() - 120_000));
      }),
    );
    expect(liveRecovered).toBe(0);
    first.kill("SIGKILL");
    await new Promise<void>((resolve) => first.once("exit", () => resolve()));

    const second = startResumeRunner("resume", id.resumeRun, hash);
    const resumed = await waitForRunnerExit(second);
    expect(resumed.code).toBe(0);
    expect(resumed.output).toContain('STAGED completed {"ingested":1,"skipped":0,"failed":0}');
    expect(resumed.output).not.toContain("persist activity replayed unexpectedly");

    const rows = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return {
          documents: yield* db.query((d) => d
            .select()
            .from(sourceDocuments)
            .where(eq(sourceDocuments.vaultId, id.vault)))
            .pipe(Effect.orDie),
          intents: yield* db.query((d) => d
            .select()
            .from(compileIntents)
            .where(eq(compileIntents.pipelineRunId, id.resumeRun)))
            .pipe(Effect.orDie),
        };
      }),
    );
    expect(rows.documents).toHaveLength(1);
    expect(rows.intents).toHaveLength(1);
  }, 60_000);

  it("dispatches the compile workflow through the no-topics publish happy path", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(compileIntents)
          .values({ id: id.compileIntent, vaultId: id.vault }))
          .pipe(Effect.orDie);
        const reconciler = yield* CompileIntentReconciler;
        expect((yield* reconciler.reconcileOnce()).dispatched).toBe(1);
        expect((yield* reconcileUntilSatisfied(reconciler)).satisfied).toBe(1);
      }),
    );

    const rows = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return {
          intent: yield* db.query((d) => d
            .select()
            .from(compileIntents)
            .where(eq(compileIntents.id, id.compileIntent)))
            .pipe(Effect.orDie),
          pipeline: yield* db.query((d) => d
            .select()
            .from(pipelineRuns)
            .where(eq(pipelineRuns.id, id.compileIntent)))
            .pipe(Effect.orDie),
          task: yield* db.query((d) => d
            .select()
            .from(tasks)
            .where(eq(tasks.id, id.compileIntent)))
            .pipe(Effect.orDie),
        };
      }),
    );
    expect(rows.intent[0]?.satisfiedAt).not.toBeNull();
    expect(rows.pipeline[0]).toMatchObject({
      status: "completed",
      currentPhase: "publish",
      phaseStatus: "completed",
      error: null,
    });
    expect(rows.pipeline[0]?.progressSteps).toEqual([
      {
        key: "phase",
        label: "compile completed early: no validated topics",
        status: "completed",
        done: 1,
        total: 1,
        detail: "",
      },
    ]);
    expect(rows.task[0]).toMatchObject({ type: "compile" });
  }, 30_000);

  it("preserves the last render progress snapshot when a later phase seam fails", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: id.renderFailureRun,
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

    const result = await Effect.runPromise(
      Effect.result(
        CompileWorkflow.execute({
          intentId: id.renderFailureIntent,
          vaultId: id.vault,
          pipelineRunId: id.renderFailureRun,
        }),
      ).pipe(Effect.provide(RenderFailureLive)),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "CompilePhaseFailed",
        phase: "render",
        errorType: "Error",
        message: "forced render seam",
      },
    });

    const rows = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select()
          .from(pipelineRuns)
          .where(eq(pipelineRuns.id, id.renderFailureRun)))
          .pipe(Effect.orDie);
      }),
    );
    expect(rows[0]).toMatchObject({
      status: "failed",
      currentPhase: "render",
      phaseStatus: "failed",
      error: "Error: forced render seam",
    });
    expect(logEvents).toContainEqual({
      event: "compile_workflow.phase_failed",
      fields: expect.objectContaining({
        pipeline_run_id: id.renderFailureRun,
        step: "render",
        error_type: "Error",
        error_message: "forced render seam",
      }),
    });
    expect(rows[0]?.progressSteps).toEqual([
      {
        key: "plan_articles",
        label: "Planning articles",
        status: "completed",
        done: 1,
        total: 1,
        detail: "",
      },
      {
        key: "write_articles",
        label: "Writing articles",
        status: "running",
        done: 0,
        total: 1,
        detail: "",
      },
      {
        key: "index_articles",
        label: "Indexing articles",
        status: "pending",
        done: null,
        total: null,
        detail: "",
      },
    ]);
  }, 30_000);

  it("keeps queued compile-intent runs out of zombie recovery", async () => {
    const recovered = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: id.queuedRun,
            vaultId: id.vault,
            trigger: "staged_files",
            status: "pending",
            currentPhase: "source_ingest",
            phaseStatus: "completed",
            progressSteps: [],
            updatedAt: new Date(0),
          }))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
          .insert(compileIntents)
          .values({ id: id.queuedIntent, vaultId: id.vault, pipelineRunId: id.queuedRun }))
          .pipe(Effect.orDie);
        const pipeline = yield* PipelineRunsService;
        return yield* pipeline.recoverZombies(new Date(Date.now() - 120_000));
      }),
    );
    expect(recovered).toBe(0);

    const rows = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select()
          .from(pipelineRuns)
          .where(eq(pipelineRuns.id, id.queuedRun)))
          .pipe(Effect.orDie);
      }),
    );
    expect(rows[0]?.status).toBe("pending");
  });

  it("fails a stale active run when enqueue never reached the workflow journal", async () => {
    const recovered = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: id.zombieRun,
            vaultId: id.vault,
            trigger: "staged_files",
            status: "running",
            currentPhase: "source_ingest",
            phaseStatus: "started",
            progressSteps: [],
            activeTaskId: id.zombieRun,
            activeTaskType: "staged_file_ingest",
            updatedAt: new Date(0),
          }))
          .pipe(Effect.orDie);
        const pipeline = yield* PipelineRunsService;
        return yield* pipeline.recoverZombies(new Date(Date.now() - 120_000));
      }),
    );
    expect(recovered).toBe(1);
  });

  it("does not let a completed ingest journal mask a missing active compile request", async () => {
    const recovered = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: id.maskedCompileRun,
            vaultId: id.vault,
            trigger: "staged_files",
            status: "running",
            currentPhase: "source_ingest",
            phaseStatus: "completed",
            progressSteps: [],
            compileIntentId: id.maskedCompileIntent,
            activeTaskId: id.maskedCompileIntent,
            activeTaskType: "compile",
            updatedAt: new Date(0),
          }))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
          .insert(compileIntents)
          .values({
            id: id.maskedCompileIntent,
            vaultId: id.vault,
            pipelineRunId: id.maskedCompileRun,
            dispatchedAt: new Date(0),
            dispatchedTaskId: id.maskedCompileIntent,
          }))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
          .execute(sql`
          INSERT INTO cluster_messages (
            id,
            message_id,
            shard_id,
            entity_type,
            entity_id,
            kind,
            tag,
            payload,
            processed,
            request_id
          ) VALUES (
            900000000000000001,
            'Workflow/StagedFileIngest/old-ingest/run/',
            'default:1',
            'Workflow/StagedFileIngest',
            'old-ingest',
            0,
            'run',
            ${JSON.stringify({ pipelineRunId: id.maskedCompileRun })},
            true,
            900000000000000001
          )
        `))
          .pipe(Effect.orDie);
        const pipeline = yield* PipelineRunsService;
        return yield* pipeline.recoverZombies(new Date(Date.now() - 120_000));
      }),
    );
    expect(recovered).toBe(1);

    const rows = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select()
          .from(pipelineRuns)
          .where(eq(pipelineRuns.id, id.maskedCompileRun)))
          .pipe(Effect.orDie);
      }),
    );
    expect(rows[0]).toMatchObject({
      status: "failed",
      phaseStatus: "failed",
      error: "Pipeline interrupted — server may have restarted during processing.",
    });
  });

  it("does not satisfy a terminal run without a compile workflow journal entry", async () => {
    const satisfied = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: id.terminalRun,
            vaultId: id.vault,
            trigger: "manual",
            status: "failed",
            currentPhase: "source_ingest",
            phaseStatus: "failed",
            progressSteps: [],
            completedAt: new Date(),
          }))
          .pipe(Effect.orDie);
        yield* db.query((d) => d
          .insert(compileIntents)
          .values({
            id: id.terminalIntent,
            vaultId: id.vault,
            pipelineRunId: id.terminalRun,
            dispatchedAt: new Date(),
            dispatchedTaskId: id.terminalIntent,
          }))
          .pipe(Effect.orDie);
        const reconciler = yield* CompileIntentReconciler;
        return (yield* reconciler.reconcileOnce()).satisfied;
      }),
    );
    expect(satisfied).toBe(0);
  });

  it("keeps compile workflow terminal states stable", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: id.terminalRun,
            vaultId: id.vault,
            trigger: "manual",
            status: "cancelled",
            currentPhase: "source_ingest",
            phaseStatus: "cancelled",
            progressSteps: [],
            completedAt: new Date(),
          }))
          .pipe(Effect.orDie);
        yield* CompileWorkflow.execute(
          {
            intentId: id.terminalIntent,
            vaultId: id.vault,
            pipelineRunId: id.terminalRun,
          },
          { discard: true },
        );
        yield* Effect.sleep("250 millis");
      }),
    );

    const rows = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query((d) => d
          .select()
          .from(pipelineRuns)
          .where(eq(pipelineRuns.id, id.terminalRun)))
          .pipe(Effect.orDie);
      }),
    );
    expect(rows[0]).toMatchObject({
      status: "cancelled",
      currentPhase: "source_ingest",
      phaseStatus: "cancelled",
    });
    // The phase-boundary guard interrupts before any phase runs, so the
    // workflow writes nothing for a cancelled run.
    expect(written.size).toBe(0);
  }, 30_000);
});
