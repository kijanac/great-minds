import { FileFingerprint, type Uuid } from "@great-minds/domain";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";

import { AppConfig, type AppConfigShape } from "../../src/config.ts";
import { DrizzleLive } from "../../src/db.ts";
import { StructuredLogger } from "../../src/logging.ts";
import { PipelineRunsServiceLive } from "../../src/pipeline-runs.ts";
import { identifySourceMarkdown, sourceIdForKey } from "../../src/source-identity.ts";
import { SourceDocumentsService, SourceDocumentsServiceLive } from "../../src/source-documents.ts";
import {
  StagedFileIngestPersistResult,
  StagedFileIngestWorkflow,
  StagedFileIngestWorkflowLive,
} from "../../src/staged-file-ingest-workflow.ts";
import { ContentStorage, StagedStorage } from "../../src/storage.ts";
import { WorkflowEngineLive } from "../../src/workflow-engine.ts";

const mode = process.argv[2];
const vaultId = process.argv[3] as Uuid | undefined;
const pipelineRunId = process.argv[4] as Uuid | undefined;
const hashInput = process.argv[5];

if (
  (mode !== "pause" && mode !== "resume") ||
  vaultId === undefined ||
  pipelineRunId === undefined ||
  hashInput === undefined
) {
  throw new Error("mode, vault id, pipeline run id, and hash are required");
}
const hash = Schema.decodeUnknownSync(FileFingerprint)(hashInput);

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required");
}

const config: AppConfigShape = {
  databaseUrl: Redacted.make(databaseUrl),
  jwtSecret: Redacted.make("staged-resume-test-secret"),
  jwtAccessExpiryMinutes: 30,
  jwtRefreshExpiryDays: 7,
  authCodeExpiryMinutes: 10,
  webauthnRpId: "localhost",
  webauthnOrigins: ["http://localhost:5173"],
  webauthnRpName: "Great Minds",
  resendApiKey: Option.none(),
  resendFromEmail: Option.none(),
  dataDir: "/tmp/gm-staged-resume-test",
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

const ConfigLive = Layer.succeed(AppConfig, config);
const LoggerLive = Layer.succeed(StructuredLogger, {
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
});
const StorageLive = Layer.succeed(ContentStorage, {
  listMarkdown: () => Effect.succeed([]),
  readText: () => Effect.die("unused"),
  writeText: () => Effect.void,
  appendText: () => Effect.die("unused"),
  exists: () => Effect.succeed(false),
  deletePath: () => Effect.void,
  clear: () => Effect.void,
});
const StagedStorageLive = Layer.succeed(StagedStorage, {
  pruneExpiredStaged: () => Effect.void,
  prepareStagedPut: () =>
    Effect.succeed({ transport: "presigned" as const, url: "https://example.invalid" }),
  writeStagedBytes: () => Effect.die(new Error("unused")),
  readStagedBytes: () => Effect.die(new Error("persist activity replayed unexpectedly")),
  deleteStaged: () => Effect.void,
  clearStaged: () => Effect.void,
});
const BaseLive = Layer.mergeAll(DrizzleLive.pipe(Layer.provideMerge(ConfigLive)), LoggerLive);
const PipelineLive = PipelineRunsServiceLive.pipe(Layer.provideMerge(BaseLive));
const SourceDocumentsLive = SourceDocumentsServiceLive.pipe(
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(BaseLive),
);
const EngineLive = WorkflowEngineLive.pipe(Layer.provideMerge(BaseLive));

const PauseAfterPersistLive = StagedFileIngestWorkflow.toLayer(() => {
  const persist = Activity.make({
    name: "staged-file-ingest-persist",
    success: StagedFileIngestPersistResult,
    execute: Effect.gen(function* () {
      const documents = yield* SourceDocumentsService;
      const sourceId = sourceIdForKey(vaultId, `upload:${hash}`);
      yield* documents.batchIndex(vaultId, [
        {
          filePath: `raw/docs/${sourceId}.md`,
          content: identifySourceMarkdown(
            "---\nsource_type: document\n---\n# Persisted before crash",
            sourceId,
          ),
          clientHash: hash,
        },
      ]);
      return { ingested: 1, skipped: 0, failures: [], cleanupHashes: [hash] };
    }),
  });
  return Effect.gen(function* () {
    const result = yield* persist;
    console.log("STAGED persist journaled");
    yield* Effect.sleep("60 seconds");
    return {
      ingested: result.ingested,
      skipped: result.skipped,
      failed: result.failures.length,
    };
  });
});

const HandlerLive = mode === "pause" ? PauseAfterPersistLive : StagedFileIngestWorkflowLive;
const MainLive = HandlerLive.pipe(
  Layer.provideMerge(SourceDocumentsLive),
  Layer.provideMerge(PipelineLive),
  Layer.provideMerge(StorageLive),
  Layer.provideMerge(StagedStorageLive),
  Layer.provideMerge(EngineLive),
  Layer.provideMerge(BaseLive),
);

const result = await Effect.runPromise(
  StagedFileIngestWorkflow.execute({
    vaultId,
    pipelineRunId,
    files: [{ name: "resume.md", size: 1, hash, mimetype: "text/markdown" }],
  }).pipe(Effect.provide(MainLive)),
);
console.log(`STAGED completed ${JSON.stringify(result)}`);
