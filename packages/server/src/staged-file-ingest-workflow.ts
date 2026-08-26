import {
  compileIntents,
  Database,
  fileIngestBatches,
  fileIngestFiles,
  pipelineRuns,
  sourceDocuments,
} from "@great-minds/database";
import { FileFingerprint, Uuid } from "@great-minds/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import * as Workflow from "effect/unstable/workflow/Workflow";

import { stagedFileToMarkdown } from "./conversion.ts";
import { fileContentHash, rawFileHash } from "./crypto.ts";
import { causeDetails, formatError } from "./error-details.ts";
import { buildDocument } from "./markdown.ts";
import { StructuredLogger } from "./logging.ts";
import { PipelineRunsService, progressSteps } from "./pipeline-runs.ts";
import { identifySourceMarkdown, sourceIdForKey } from "./source-identity.ts";
import { SourceDocumentsService } from "./source-documents.ts";
import { ContentStorage, StagedStorage, vaultOwner } from "./storage.ts";

export const STAGED_FILE_INGEST_STEP_LABELS = {
  prepare_sources: "Preparing uploaded sources",
  read_files: "Reading uploaded files",
  index_documents: "Indexing documents",
} as const;

const BATCH_SIZE = 50;

const StagedFile = Schema.Struct({
  name: Schema.String,
  size: Schema.Number,
  hash: FileFingerprint,
  mimetype: Schema.String,
  needsCompile: Schema.Boolean,
});

export const StagedFileIngestWorkflow = Workflow.make("StagedFileIngest", {
  payload: {
    vaultId: Uuid,
    batchId: Uuid,
    pipelineRunId: Uuid,
    files: Schema.Array(StagedFile),
  },
  idempotencyKey: ({ pipelineRunId }) => pipelineRunId,
  success: Schema.Struct({
    ingested: Schema.Number,
    skipped: Schema.Number,
    failed: Schema.Number,
  }),
});

const StagedFileFailure = Schema.Struct({
  name: Schema.String,
  hash: FileFingerprint,
  error: Schema.String,
});

export const StagedFileIngestPersistResult = Schema.Struct({
  ingested: Schema.Number,
  skipped: Schema.Number,
  failures: Schema.Array(StagedFileFailure),
  cleanupHashes: Schema.Array(FileFingerprint),
});

export const StagedFileIngestWorkflowLive = StagedFileIngestWorkflow.toLayer((payload) => {
  const persist = Activity.make({
    name: "staged-file-ingest-persist",
    success: StagedFileIngestPersistResult,
    execute: Effect.gen(function* () {
      const db = yield* Database;
      const storage = yield* ContentStorage;
      const stagedStorage = yield* StagedStorage;
      const sourceDocumentsService = yield* SourceDocumentsService;
      const pipeline = yield* PipelineRunsService;
      const logger = yield* StructuredLogger;
      const vaultId = payload.vaultId;
      const batchId = payload.batchId;
      const runId = payload.pipelineRunId;
      const total = payload.files.length;

      const existingRows = yield* db.query((d) => d
        .select({ path: sourceDocuments.filePath, hash: sourceDocuments.fileHash })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.vaultId, vaultId)));
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
              const bytes = yield* stagedStorage.readStagedBytes(vaultId, batchId, file.hash);
              if (bytes.byteLength !== file.size || rawFileHash(bytes) !== file.hash) {
                throw new Error(`Staged file integrity check failed: ${file.name}`);
              }
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
      const failures: { name: string; hash: FileFingerprint; error: string }[] = [];
      const seen = new Set<string>();
      const cleanup = payload.files.map((file) => file.hash);
      let batch: {
        filePath: string;
        content: string;
        clientHash: typeof FileFingerprint.Type;
      }[] = [];

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
            counts: {
              index_documents: [ingested + skipped + failures.length, total],
            },
          }),
        );
      });

      for (const [index, result] of converted.entries()) {
        if (Exit.isFailure(result)) {
          const file = payload.files[index];
          if (file === undefined) {
            throw new Error(`Converted staged file ${index} has no input entry`);
          }
          const error = causeDetails(result.cause);
          failures.push({
            name: file.name,
            hash: file.hash,
            error: "The file could not be read or converted",
          });
          yield* logger.warn("staged_file_ingest.fetch_failed", {
            vault_id: vaultId,
            pipeline_run_id: runId,
            file_name: file.name,
            error: error.errorType,
            error_message: error.message,
          });
          continue;
        }
        const { content, file } = result.value;
        const sourceId = sourceIdForKey(vaultId, `upload:${file.hash}`);
        const dest = `raw/docs/${sourceId}.md`;
        const identified = identifySourceMarkdown(content, sourceId);
        const contentHash = fileContentHash(identified);
        if (existingHashes.get(dest) === contentHash || seen.has(dest)) {
          if (file.needsCompile) ingested += 1;
          else skipped += 1;
          continue;
        }
        yield* requireActive();
        yield* storage.writeText(vaultOwner(vaultId), dest, identified);
        seen.add(dest);
        batch.push({ filePath: dest, content: identified, clientHash: file.hash });
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
          counts: {
            index_documents: [ingested + skipped + failures.length, total],
          },
        }),
      );

      const failedHashes = new Set(failures.map((failure) => failure.hash));
      const completedHashes = payload.files
        .filter((file) => !failedHashes.has(file.hash))
        .map((file) => file.hash);
      if (completedHashes.length > 0) {
        yield* db.query((d) => d
          .update(fileIngestFiles)
          .set({ status: "completed", completedAt: sql`now()`, updatedAt: sql`now()` })
          .where(
            and(
              eq(fileIngestFiles.batchId, batchId),
              inArray(fileIngestFiles.hash, completedHashes),
              eq(fileIngestFiles.status, "processing"),
            ),
          ));
      }
      yield* Effect.forEach(
        failures,
        (failure) =>
          db.query((d) => d
            .update(fileIngestFiles)
            .set({
              status: "failed",
              error: failure.error,
              completedAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(fileIngestFiles.batchId, batchId),
                eq(fileIngestFiles.hash, failure.hash),
                eq(fileIngestFiles.status, "processing"),
              ),
            )),
        { concurrency: 4 },
      );

      return { ingested, skipped, failures, cleanupHashes: cleanup };
    }),
  });

  const finalize = (result: typeof StagedFileIngestPersistResult.Type) =>
    Activity.make({
      name: "staged-file-ingest-finalize",
      success: StagedFileIngestWorkflow.successSchema,
      execute: Effect.gen(function* () {
        const db = yield* Database;
        const stagedStorage = yield* StagedStorage;
        const pipeline = yield* PipelineRunsService;
        const logger = yield* StructuredLogger;
        const vaultId = payload.vaultId;
        const batchId = payload.batchId;
        const runId = payload.pipelineRunId;
        const total = payload.files.length;

        const { ingested, skipped, failures, cleanupHashes } = result;
        const failed = failures.length;

        const cleanupResults = yield* Effect.forEach(
          cleanupHashes,
          (hash) => Effect.exit(stagedStorage.deleteStaged(vaultId, batchId, hash)),
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

        if (failed > 0) {
          const error = `${failed} of ${total} files could not be ingested`;
          const detail = failures
            .map((failure) => `${failure.name}: ${failure.error}`)
            .join("; ");
          yield* pipeline.updateProgress(
            runId,
            "source_ingest",
            "failed",
            progressSteps(STAGED_FILE_INGEST_STEP_LABELS, "read_files", {
              completed: new Set(["prepare_sources"]),
              failed: new Set(["read_files"]),
              counts: {
                read_files: [total, total],
                index_documents: [ingested + skipped, total],
              },
              details: { read_files: detail },
            }),
            error,
          );
        } else if (ingested > 0) {
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
            );
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
        yield* db.query((d) => d
          .update(fileIngestBatches)
          .set({
            status: failed > 0 ? "failed" : "completed",
            error: failed > 0 ? `${failed} of ${total} files could not be ingested` : null,
            completedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(fileIngestBatches.id, batchId),
              eq(fileIngestBatches.status, "processing"),
            ),
          ));
        return { ingested, skipped, failed };
      }),
    });

  const failRun = <E>(step: "persist" | "finalize", cause: Cause.Cause<E>) =>
    Effect.gen(function* () {
      const db = yield* Database;
      const pipeline = yield* PipelineRunsService;
      const logger = yield* StructuredLogger;
      const error = causeDetails(cause);
      const formatted = formatError(error);
      yield* logger.error("staged_file_ingest.failed", {
        vault_id: payload.vaultId,
        pipeline_run_id: payload.pipelineRunId,
        step,
        error_type: error.errorType,
        error_message: error.message,
      });
      yield* pipeline.updateProgress(
        payload.pipelineRunId,
        "source_ingest",
        "failed",
        progressSteps(STAGED_FILE_INGEST_STEP_LABELS, "prepare_sources", {
          failed: new Set(["prepare_sources"]),
          details: { prepare_sources: formatted },
        }),
        formatted,
      );
      yield* db.query((d) => d
        .update(fileIngestBatches)
        .set({
          status: "failed",
          error: formatted,
          completedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(fileIngestBatches.id, payload.batchId),
            eq(fileIngestBatches.status, "processing"),
          ),
        ));
      yield* db.query((d) => d
        .update(fileIngestFiles)
        .set({
          status: "failed",
          error: formatted,
          completedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(fileIngestFiles.batchId, payload.batchId),
            eq(fileIngestFiles.status, "processing"),
          ),
        ));
      return yield* Effect.failCause(cause);
    });

  const recoverTerminal = <E>(step: "persist" | "finalize", cause: Cause.Cause<E>) => {
    if (cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason)) {
      return Effect.failCause(cause);
    }
    return failRun(step, cause);
  };

  return Effect.gen(function* () {
    const persisted = yield* Activity.retry(Effect.sandbox(persist), { times: 1 }).pipe(
      Effect.catch((cause) => Effect.failCause(cause)),
      Effect.catchCause((cause) => recoverTerminal("persist", cause)),
    );
    return yield* Activity.retry(Effect.sandbox(finalize(persisted)), { times: 1 }).pipe(
      Effect.catch((cause) => Effect.failCause(cause)),
      Effect.catchCause((cause) => recoverTerminal("finalize", cause)),
    );
  });
});
