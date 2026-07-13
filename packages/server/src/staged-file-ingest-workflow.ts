import {
  compileIntents,
  Database,
  pipelineRuns,
  sourceDocuments,
  vaults,
} from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import * as Workflow from "effect/unstable/workflow/Workflow";

import { AppConfig } from "./config.ts";
import { stagedFileToMarkdown } from "./conversion.ts";
import { fileContentHash } from "./crypto.ts";
import { dieDatabase } from "./db-defects.ts";
import { buildDocument } from "./markdown.ts";
import { StructuredLogger } from "./logging.ts";
import { PipelineRunsService, progressSteps } from "./pipeline-runs.ts";
import { SourceDocumentsService } from "./source-documents.ts";
import { VaultStorage } from "./storage.ts";

const STAGED_FILE_INGEST_STEP_LABELS = {
  prepare_sources: "Preparing uploaded sources",
  read_files: "Reading uploaded files",
  index_documents: "Indexing documents",
} as const;

const BATCH_SIZE = 50;

const StagedFile = Schema.Struct({
  name: Schema.String,
  size: Schema.Number,
  hash: Schema.String,
  mimetype: Schema.String,
});

export const StagedFileIngestWorkflow = Workflow.make("StagedFileIngest", {
  payload: {
    vaultId: Schema.String,
    pipelineRunId: Schema.String,
    files: Schema.Array(StagedFile),
  },
  idempotencyKey: ({ pipelineRunId }) => pipelineRunId,
  success: Schema.Struct({
    ingested: Schema.Number,
    skipped: Schema.Number,
    failed: Schema.Number,
  }),
});

export const StagedFileIngestPersistResult = Schema.Struct({
  ingested: Schema.Number,
  skipped: Schema.Number,
  failed: Schema.Number,
  cleanupHashes: Schema.Array(Schema.String),
});

const causeError = (cause: Cause.Cause<unknown>) => {
  const reason = cause.reasons[0];
  const error =
    reason !== undefined && Cause.isFailReason(reason)
      ? reason.error
      : reason !== undefined && Cause.isDieReason(reason)
        ? reason.defect
        : cause;
  if (typeof error === "object" && error !== null && "errorType" in error) {
    return {
      type: String(error.errorType),
      message: "message" in error ? String(error.message) : String(error),
    };
  }
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return {
      type: String(error._tag),
      message: "message" in error ? String(error.message) : String(error),
    };
  }
  return {
    type: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  };
};

export const StagedFileIngestWorkflowLive = StagedFileIngestWorkflow.toLayer((payload) => {
  const persist = Activity.make({
    name: "staged-file-ingest-persist",
    success: StagedFileIngestPersistResult,
    execute: Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Database;
      const storage = yield* VaultStorage;
      const sourceDocumentsService = yield* SourceDocumentsService;
      const pipeline = yield* PipelineRunsService;
      const logger = yield* StructuredLogger;
      const vaultId = payload.vaultId as Uuid;
      const runId = payload.pipelineRunId as Uuid;
      const total = payload.files.length;

      if (config.storageBackend !== "r2") {
        throw new Error("staged_file_ingest requires r2 storage backend");
      }
      const vaultRows = yield* db
        .select({ bucket: vaults.r2BucketName })
        .from(vaults)
        .where(eq(vaults.id, vaultId))
        .limit(1)
        .pipe(dieDatabase);
      const vault = vaultRows[0];
      if (vault === undefined) {
        throw new Error(`Vault ${vaultId} not found`);
      }
      if (vault.bucket === null || vault.bucket.length === 0) {
        throw new Error(`Vault ${vaultId} has no r2_bucket_name`);
      }
      const bucket = vault.bucket;
      const existingRows = yield* db
        .select({ path: sourceDocuments.filePath, hash: sourceDocuments.fileHash })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.vaultId, vaultId))
        .pipe(dieDatabase);
      const existingHashes = new Map(existingRows.map((row) => [row.path, row.hash]));

      yield* pipeline.updateProgress(
        runId,
        "source_ingest",
        "started",
        progressSteps(STAGED_FILE_INGEST_STEP_LABELS, "prepare_sources", {
          counts: { read_files: [0, total] },
        }),
      );
      yield* pipeline.updateProgress(
        runId,
        "source_ingest",
        "progress",
        progressSteps(STAGED_FILE_INGEST_STEP_LABELS, "read_files", {
          completed: new Set(["prepare_sources"]),
          counts: { read_files: [0, total] },
        }),
      );

      const converted = yield* Effect.forEach(
        payload.files,
        (file) =>
          Effect.exit(
            Effect.gen(function* () {
              const bytes = yield* storage.readStagedBytes(vaultId, bucket, file.hash);
              const markdown = yield* Effect.tryPromise({
                try: () => stagedFileToMarkdown(bytes, file.name, file.mimetype),
                catch: (error) => error,
              });
              return { file, content: buildDocument(markdown, { sourceType: "document" }) };
            }),
          ),
        { concurrency: 4 },
      );

      let ingested = 0;
      let skipped = 0;
      let failed = 0;
      const seen = new Set<string>();
      const cleanup: string[] = [];
      let batch: { filePath: string; content: string; clientHash: string }[] = [];

      const requireActive = Effect.fn(function* () {
        if (!(yield* pipeline.isActive(runId))) return yield* Effect.interrupt;
      });

      const flush = Effect.fn(function* () {
        if (batch.length === 0) {
          return;
        }
        yield* requireActive();
        yield* sourceDocumentsService.batchIndex(vaultId, batch);
        batch = [];
        yield* pipeline.updateProgress(
          runId,
          "source_ingest",
          "progress",
          progressSteps(STAGED_FILE_INGEST_STEP_LABELS, "index_documents", {
            completed: new Set(["prepare_sources", "read_files"]),
            counts: { index_documents: [ingested + skipped, total] },
          }),
        );
      });

      for (const [index, result] of converted.entries()) {
        if (Exit.isFailure(result)) {
          failed += 1;
          const file = payload.files[index];
          if (file === undefined) {
            throw new Error(`Converted staged file ${index} has no input entry`);
          }
          const error = causeError(result.cause);
          yield* logger.warn("staged_file_ingest.fetch_failed", {
            vault_id: vaultId,
            pipeline_run_id: runId,
            file_name: file.name,
            error: error.type,
            error_message: error.message,
          });
          continue;
        }
        const { content, file } = result.value;
        const dest = `raw/docs/${file.hash.slice(0, 12)}.md`;
        cleanup.push(file.hash);
        const contentHash = fileContentHash(content);
        if (existingHashes.get(dest) === contentHash || seen.has(dest)) {
          skipped += 1;
          continue;
        }
        yield* requireActive();
        yield* storage.writeText(vaultId, dest, content, bucket);
        seen.add(dest);
        batch.push({ filePath: dest, content, clientHash: file.hash });
        ingested += 1;
        if (batch.length >= BATCH_SIZE) {
          yield* flush();
        }
      }
      yield* flush();

      yield* pipeline.updateProgress(
        runId,
        "source_ingest",
        "progress",
        progressSteps(STAGED_FILE_INGEST_STEP_LABELS, "index_documents", {
          completed: new Set(["prepare_sources", "read_files"]),
          counts: { index_documents: [ingested + skipped, total] },
        }),
      );

      return { ingested, skipped, failed, cleanupHashes: cleanup };
    }),
  });

  const finalize = (result: typeof StagedFileIngestPersistResult.Type) =>
    Activity.make({
      name: "staged-file-ingest-finalize",
      success: StagedFileIngestWorkflow.successSchema,
      execute: Effect.gen(function* () {
        const config = yield* AppConfig;
        const db = yield* Database;
        const storage = yield* VaultStorage;
        const pipeline = yield* PipelineRunsService;
        const logger = yield* StructuredLogger;
        const vaultId = payload.vaultId as Uuid;
        const runId = payload.pipelineRunId as Uuid;
        const total = payload.files.length;

        if (config.storageBackend !== "r2") {
          throw new Error("staged_file_ingest requires r2 storage backend");
        }
        const vaultRows = yield* db
          .select({ bucket: vaults.r2BucketName })
          .from(vaults)
          .where(eq(vaults.id, vaultId))
          .limit(1)
          .pipe(dieDatabase);
        const bucket = vaultRows[0]?.bucket;
        if (bucket === undefined) {
          throw new Error(`Vault ${vaultId} not found`);
        }
        if (bucket === null || bucket.length === 0) {
          throw new Error(`Vault ${vaultId} has no r2_bucket_name`);
        }

        const { ingested, skipped, failed, cleanupHashes } = result;

        if (ingested > 0) {
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const intents = yield* tx
                  .insert(compileIntents)
                  .values({ vaultId, pipelineRunId: runId })
                  .onConflictDoUpdate({
                    target: compileIntents.vaultId,
                    targetWhere: sql`${compileIntents.dispatchedAt} IS NULL`,
                    set: { vaultId: sql`compile_intents.vault_id` },
                  })
                  .returning({
                    id: compileIntents.id,
                    pipelineRunId: compileIntents.pipelineRunId,
                  });
                const intent = intents[0];
                if (intent === undefined) {
                  throw new Error("compile intent upsert returned no row");
                }
                if (intent.pipelineRunId === null) {
                  yield* tx
                    .update(compileIntents)
                    .set({ pipelineRunId: runId })
                    .where(eq(compileIntents.id, intent.id));
                }
                yield* tx
                  .update(pipelineRuns)
                  .set({ compileIntentId: intent.id, updatedAt: sql`now()` })
                  .where(eq(pipelineRuns.id, runId));
              }),
            )
            .pipe(dieDatabase);
          const cleanupResults = yield* Effect.forEach(
            cleanupHashes,
            (hash) => Effect.exit(storage.deleteStaged(vaultId, bucket, hash)),
            { concurrency: 4 },
          );
          const cleanupFailures = cleanupResults.filter(Exit.isFailure).length;
          if (cleanupFailures > 0) {
            yield* logger.warn("staged_file_ingest.cleanup_failures", {
              vault_id: vaultId,
              pipeline_run_id: runId,
              failed: cleanupFailures,
              total: cleanupHashes.length,
            });
          }
          yield* pipeline.updateProgress(
            runId,
            "source_ingest",
            "completed",
            progressSteps(STAGED_FILE_INGEST_STEP_LABELS, "index_documents", {
              completed: new Set(Object.keys(STAGED_FILE_INGEST_STEP_LABELS)),
              counts: {
                read_files: [total, total],
                index_documents: [ingested + skipped, total],
              },
            }),
          );
        } else if (failed > 0) {
          const error = `${failed} source(s) failed before compile`;
          yield* pipeline.updateProgress(
            runId,
            "source_ingest",
            "failed",
            progressSteps(STAGED_FILE_INGEST_STEP_LABELS, "index_documents", {
              completed: new Set(["prepare_sources", "read_files"]),
              failed: new Set(["index_documents"]),
              details: { index_documents: error },
            }),
            error,
          );
        } else {
          yield* pipeline.updateProgress(runId, "publish", "completed", [
            {
              key: "publish",
              label: "sources already up to date",
              status: "completed",
              done: 1,
              total: 1,
              detail: "",
            },
          ]);
        }
        return { ingested, skipped, failed };
      }),
    });

  const workflow = Effect.gen(function* () {
    const persisted = yield* Activity.retry(Effect.sandbox(persist), { times: 1 }).pipe(
      Effect.catch((cause) => Effect.failCause(cause)),
    );
    return yield* Activity.retry(Effect.sandbox(finalize(persisted)), { times: 1 }).pipe(
      Effect.catch((cause) => Effect.failCause(cause)),
    );
  });

  return workflow.pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const pipeline = yield* PipelineRunsService;
        yield* pipeline.updateProgress(
          payload.pipelineRunId as Uuid,
          "source_ingest",
          "failed",
          progressSteps(STAGED_FILE_INGEST_STEP_LABELS, "prepare_sources", {
            failed: new Set(["prepare_sources"]),
            details: { prepare_sources: String(cause) },
          }),
          String(cause),
        );
        return yield* Effect.failCause(cause);
      }),
    ),
  );
});
