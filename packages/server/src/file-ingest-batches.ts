import {
  Database,
  fileIngestBatches,
  fileIngestFiles,
  pipelineRuns,
  sourceDocuments,
  tasks,
} from "@great-minds/database";
import {
  BadRequest,
  Conflict,
  type FileFingerprint,
  type FileIngestBatch as FileIngestBatchResponse,
  type FileIngestFileInput,
  type FileIngestUploadTarget,
  Forbidden,
  type JobResponse,
  NotFound,
  type Uuid,
} from "@great-minds/domain";
import { and, asc, count, eq, inArray, lt, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer } from "effect";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";

import { ClockService } from "./clock.ts";
import { rawFileHash } from "./crypto.ts";
import { jobResponse } from "./job-response.ts";
import { StructuredLogger } from "./logging.ts";
import { PipelineRunsService, progressSteps } from "./pipeline-runs.ts";
import { SourceDocumentsService } from "./source-documents.ts";
import {
  STAGED_FILE_INGEST_STEP_LABELS,
  StagedFileIngestWorkflow,
} from "./staged-file-ingest-workflow.ts";
import {
  StagedStorage,
  StagedUploadGateway,
} from "./storage.ts";
import { VaultAccessService } from "./vaults.ts";

const STAGED_TASK_TYPE = "staged_file_ingest";
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const UPLOAD_EXPIRED_ERROR = "Upload expired before all files arrived";

declare const fileIngestManifestBrand: unique symbol;
export type FileIngestManifest = readonly [FileIngestFileInput, ...FileIngestFileInput[]] & {
  readonly [fileIngestManifestBrand]: true;
};

export const parseFileIngestManifest = (files: readonly FileIngestFileInput[]) => {
  if (files.length === 0) {
    return Effect.fail(new BadRequest({ detail: "no files provided" }));
  }
  const hashes = new Set<FileFingerprint>();
  for (const file of files) {
    if (hashes.has(file.hash)) {
      return Effect.fail(new BadRequest({ detail: "duplicate file hashes are not allowed" }));
    }
    hashes.add(file.hash);
  }
  return Effect.succeed(files as FileIngestManifest);
};

type UploadInput = {
  readonly hash: FileFingerprint;
  readonly rawBytes: Uint8Array;
  readonly contentType: string;
};

type BatchRecord = {
  readonly id: Uuid;
  readonly vaultId: Uuid;
  readonly createdBy: Uuid;
  readonly status: "uploading" | "processing" | "completed" | "failed" | "cancelled";
  readonly error: string | null;
  readonly expiresAt: Date;
};

type FileRecord = {
  readonly name: string;
  readonly size: number;
  readonly hash: FileFingerprint;
  readonly mimetype: string;
  readonly needsCompile: boolean;
  readonly status: "pending" | "uploaded" | "processing" | "completed" | "failed" | "cancelled";
  readonly error: string | null;
};

type FileIngestBatchesShape = {
  readonly checkDupes: (
    userId: Uuid,
    vaultId: Uuid,
    hashes: readonly FileFingerprint[],
  ) => Effect.Effect<readonly FileFingerprint[], Forbidden>;
  readonly create: (
    userId: Uuid,
    vaultId: Uuid,
    batchId: Uuid,
    files: readonly FileIngestFileInput[],
  ) => Effect.Effect<FileIngestBatchResponse, BadRequest | Conflict | Forbidden>;
  readonly get: (
    userId: Uuid,
    batchId: Uuid,
  ) => Effect.Effect<FileIngestBatchResponse, Forbidden | NotFound>;
  readonly resume: (
    userId: Uuid,
    batchId: Uuid,
  ) => Effect.Effect<FileIngestBatchResponse, BadRequest | Forbidden | NotFound>;
  readonly upload: (
    userId: Uuid,
    batchId: Uuid,
    input: UploadInput,
  ) => Effect.Effect<void, BadRequest | Forbidden | NotFound>;
  readonly acknowledge: (
    userId: Uuid,
    batchId: Uuid,
    hash: FileFingerprint,
  ) => Effect.Effect<void, BadRequest | Forbidden | NotFound>;
  readonly commit: (
    userId: Uuid,
    batchId: Uuid,
  ) => Effect.Effect<JobResponse, BadRequest | Forbidden | NotFound>;
  readonly cancel: (batchId: Uuid) => Effect.Effect<void>;
  readonly reconcileOnce: () => Effect.Effect<{
    readonly dispatched: number;
    readonly expired: number;
  }>;
};

export class FileIngestBatches extends Context.Service<
  FileIngestBatches,
  FileIngestBatchesShape
>()("@great-minds/server/FileIngestBatches") {}

const batchResponse = (
  batch: BatchRecord,
  files: readonly FileRecord[],
  targets: readonly FileIngestUploadTarget[] = [],
): FileIngestBatchResponse => ({
  id: batch.id,
  vault_id: batch.vaultId,
  created_by: batch.createdBy,
  status: batch.status,
  error: batch.error,
  expires_at: batch.expiresAt.toISOString(),
  files: files.map((file) => ({
    name: file.name,
    size: file.size,
    hash: file.hash,
    mimetype: file.mimetype,
    status: file.status,
    error: file.error,
  })),
  targets: [...targets],
});

const sameManifest = (
  expected: FileIngestManifest,
  actual: readonly FileRecord[],
) =>
  expected.length === actual.length &&
  expected.every((file, index) => {
    const row = actual[index];
    return (
      row !== undefined &&
      row.name === file.name &&
      row.size === file.size &&
      row.hash === file.hash &&
      row.mimetype === (file.mimetype ?? "")
    );
  });

export const FileIngestBatchesLive = Layer.effect(
  FileIngestBatches,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;
    const sourceDocumentsService = yield* SourceDocumentsService;
    const stagedStorage = yield* StagedStorage;
    const uploads = yield* StagedUploadGateway;
    const pipeline = yield* PipelineRunsService;
    const workflowEngine = yield* WorkflowEngine.WorkflowEngine;
    const clock = yield* ClockService;
    const logger = yield* StructuredLogger;

    const loadBatch = (batchId: Uuid) =>
      db.query((d) => d
        .select({
          id: fileIngestBatches.id,
          vaultId: pipelineRuns.vaultId,
          createdBy: fileIngestBatches.createdBy,
          status: fileIngestBatches.status,
          error: fileIngestBatches.error,
          expiresAt: fileIngestBatches.expiresAt,
        })
        .from(fileIngestBatches)
        .innerJoin(pipelineRuns, eq(pipelineRuns.id, fileIngestBatches.id))
        .where(eq(fileIngestBatches.id, batchId))
        .limit(1))
        .pipe(
          Effect.map((rows) => {
            const row = rows[0];
            return row === undefined
              ? undefined
              : ({ ...row, id: row.id as Uuid, vaultId: row.vaultId as Uuid, createdBy: row.createdBy as Uuid } satisfies BatchRecord);
          }),
        );

    const loadFiles = (batchId: Uuid) =>
      db.query((d) => d
        .select({
          name: fileIngestFiles.name,
          size: fileIngestFiles.size,
          hash: fileIngestFiles.hash,
          mimetype: fileIngestFiles.mimetype,
          needsCompile: fileIngestFiles.needsCompile,
          status: fileIngestFiles.status,
          error: fileIngestFiles.error,
        })
        .from(fileIngestFiles)
        .where(eq(fileIngestFiles.batchId, batchId))
        .orderBy(asc(fileIngestFiles.position)))
        .pipe(
          Effect.map((rows) => rows.map((row) => ({ ...row, hash: row.hash as FileFingerprint } satisfies FileRecord))),
        );

    const requireMemberBatch = (userId: Uuid, batchId: Uuid) =>
      Effect.gen(function* () {
        const batch = yield* loadBatch(batchId);
        if (batch === undefined) {
          return yield* new NotFound({ detail: "File ingest not found" });
        }
        yield* access.requireMember(userId, batch.vaultId);
        return batch;
      });

    const requireCreatorBatch = (userId: Uuid, batchId: Uuid) =>
      Effect.gen(function* () {
        const batch = yield* loadBatch(batchId);
        if (batch === undefined) {
          return yield* new NotFound({ detail: "File ingest not found" });
        }
        yield* access.requireOwner(userId, batch.vaultId);
        if (batch.createdBy !== userId) {
          return yield* new Forbidden({
            detail: "Only the owner who started this upload can continue it",
          });
        }
        return batch;
      });

    const uploadProgress = (batchId: Uuid, total: number) =>
      Effect.gen(function* () {
        const rows = yield* db.query((d) => d
          .select({ total: count() })
          .from(fileIngestFiles)
          .where(
            and(
              eq(fileIngestFiles.batchId, batchId),
              inArray(fileIngestFiles.status, ["uploaded", "processing", "completed"]),
            ),
          ));
        const uploaded = rows[0]?.total ?? 0;
        yield* pipeline.updateProgress(
          batchId,
          "source_ingest",
          "progress",
          progressSteps(STAGED_FILE_INGEST_STEP_LABELS, "prepare_sources", {
            counts: { prepare_sources: [uploaded, total], read_files: [0, total] },
          }),
        );
      });

    const markUploaded = (batch: BatchRecord, hash: FileFingerprint) =>
      Effect.gen(function* () {
        yield* db.query((d) => d
          .update(fileIngestFiles)
          .set({ status: "uploaded", uploadedAt: sql`now()`, updatedAt: sql`now()` })
          .where(
            and(
              eq(fileIngestFiles.batchId, batch.id),
              eq(fileIngestFiles.hash, hash),
              eq(fileIngestFiles.status, "pending"),
            ),
          ));
        const files = yield* loadFiles(batch.id);
        yield* uploadProgress(batch.id, files.length);
      });

    const refreshReceipts = (batch: BatchRecord, files: readonly FileRecord[]) =>
      Effect.gen(function* () {
        if (batch.status !== "uploading") return files;
        const pending = files.filter((file) => file.status === "pending");
        const existing = yield* Effect.forEach(
          pending,
          (file) =>
            stagedStorage.stagedExists(batch.vaultId, batch.id, file.hash).pipe(
              Effect.map((exists) => ({ file, exists })),
              Effect.catchTag("StorageBackendError", (error) =>
                Effect.fail(new BadRequest({ detail: error.message })),
              ),
            ),
          { concurrency: 4 },
        );
        const arrived = existing.filter((result) => result.exists).map((result) => result.file.hash);
        if (arrived.length === 0) return files;
        yield* db.query((d) => d
          .update(fileIngestFiles)
          .set({ status: "uploaded", uploadedAt: sql`now()`, updatedAt: sql`now()` })
          .where(
            and(
              eq(fileIngestFiles.batchId, batch.id),
              inArray(fileIngestFiles.hash, arrived),
              eq(fileIngestFiles.status, "pending"),
            ),
          ));
        const refreshed = yield* loadFiles(batch.id);
        yield* uploadProgress(batch.id, refreshed.length);
        return refreshed;
      });

    const prepareTargets = (batch: BatchRecord, files: readonly FileRecord[]) => {
      if (batch.status !== "uploading") return Effect.succeed([]);
      const pending = files.filter((file) => file.status === "pending");
      if (pending.length === 0) return Effect.succeed([]);
      return uploads
        .prepare(
          batch.vaultId,
          batch.id,
          pending.map((file) => ({
            hash: file.hash,
            contentType: file.mimetype || "application/octet-stream",
            contentLength: file.size,
          })),
        )
        .pipe(
          Effect.catchTag("StorageBackendError", (error) =>
            Effect.fail(new BadRequest({ detail: error.message })),
          ),
        );
    };

    const resumableResponse = (batch: BatchRecord) =>
      Effect.gen(function* () {
        const files = yield* loadFiles(batch.id);
        const refreshed = yield* refreshReceipts(batch, files);
        const targets = yield* prepareTargets(batch, refreshed);
        return batchResponse(batch, refreshed, targets);
      });

    const dispatch = (batch: BatchRecord, files: readonly FileRecord[]) =>
      StagedFileIngestWorkflow.execute(
        {
          vaultId: batch.vaultId,
          batchId: batch.id,
          pipelineRunId: batch.id,
          files: files.map((file) => ({
            name: file.name,
            size: file.size,
            hash: file.hash,
            mimetype: file.mimetype,
            needsCompile: file.needsCompile,
          })),
        },
        { discard: true },
      ).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine));

    const commit = (userId: Uuid, batchId: Uuid) =>
      Effect.gen(function* () {
        let batch = yield* requireCreatorBatch(userId, batchId);
        let files: readonly FileRecord[] = yield* loadFiles(batch.id);
        files = yield* refreshReceipts(batch, files);
        batch = (yield* loadBatch(batch.id)) ?? batch;

        if (batch.status === "failed" || batch.status === "cancelled") {
          return yield* new BadRequest({ detail: `File ingest is ${batch.status}` });
        }
        if (batch.status === "uploading") {
          const missing = files.filter((file) => file.status !== "uploaded");
          if (missing.length > 0) {
            return yield* new BadRequest({
              detail: `Waiting for uploads: ${missing.map((file) => file.name).join(", ")}`,
            });
          }

          const transitioned = yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const rows = yield* tx
                .update(fileIngestBatches)
                .set({ status: "processing", committedAt: sql`now()`, updatedAt: sql`now()` })
                .where(
                  and(
                    eq(fileIngestBatches.id, batch.id),
                    eq(fileIngestBatches.status, "uploading"),
                  ),
                )
                .returning({ id: fileIngestBatches.id });
              if (rows.length === 0) return false;
              yield* tx
                .update(fileIngestFiles)
                .set({ status: "processing", updatedAt: sql`now()` })
                .where(
                  and(
                    eq(fileIngestFiles.batchId, batch.id),
                    eq(fileIngestFiles.status, "uploaded"),
                  ),
                );
              yield* tx
                .insert(tasks)
                .values({
                  id: batch.id,
                  vaultId: batch.vaultId,
                  type: STAGED_TASK_TYPE,
                  params: {
                    batch_id: batch.id,
                    vault_id: batch.vaultId,
                    files: files.map((file) => ({
                      name: file.name,
                      size: file.size,
                      hash: file.hash,
                      mimetype: file.mimetype,
                      needs_compile: file.needsCompile,
                    })),
                    pipeline_run_id: batch.id,
                  },
                  pipelineRunId: batch.id,
                })
                .onConflictDoNothing({ target: tasks.id });
              yield* tx
                .update(pipelineRuns)
                .set({
                  ingestTaskId: batch.id,
                  activeTaskId: batch.id,
                  activeTaskType: STAGED_TASK_TYPE,
                  updatedAt: sql`now()`,
                })
                .where(eq(pipelineRuns.id, batch.id));
              return true;
            }),
          );
          if (transitioned) {
            batch = { ...batch, status: "processing" };
            files = files.map((file) => ({ ...file, status: "processing" }));
          } else {
            batch = (yield* loadBatch(batch.id)) ?? batch;
            files = yield* loadFiles(batch.id);
          }
        }

        if (batch.status === "failed" || batch.status === "cancelled") {
          return yield* new BadRequest({ detail: `File ingest is ${batch.status}` });
        }
        if (batch.status === "processing") {
          yield* dispatch(batch, files);
        }
        const rows = yield* db.query((d) => d
          .select()
          .from(pipelineRuns)
          .where(eq(pipelineRuns.id, batch.id))
          .limit(1));
        const run = rows[0];
        if (run === undefined) throw new Error(`Pipeline run missing for file ingest ${batch.id}`);
        return jobResponse(run);
      });

    const cancel = (batchId: Uuid) =>
      Effect.gen(function* () {
        const batch = yield* loadBatch(batchId);
        if (batch === undefined) return;
        yield* db.query((d) => d
          .update(fileIngestBatches)
          .set({
            status: "cancelled",
            error: "Update cancelled",
            completedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(fileIngestBatches.id, batchId),
              inArray(fileIngestBatches.status, ["uploading", "processing"]),
            ),
          ));
        yield* db.query((d) => d
          .update(fileIngestFiles)
          .set({
            status: "cancelled",
            error: "Update cancelled",
            completedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(fileIngestFiles.batchId, batchId),
              inArray(fileIngestFiles.status, ["pending", "uploaded", "processing"]),
            ),
          ));
        yield* stagedStorage.clearStagedBatch(batch.vaultId, batchId).pipe(
          Effect.catchCause((cause) =>
            logger.warn("file_ingest.cancel_cleanup_failed", {
              vault_id: batch.vaultId,
              batch_id: batchId,
              error: "Cause",
              error_message: Cause.pretty(cause),
            }),
          ),
        );
      });

    const expireUploads = Effect.gen(function* () {
      const now = yield* clock.now;
      const expired = yield* db.query((d) => d
        .select({ id: fileIngestBatches.id, vaultId: pipelineRuns.vaultId })
        .from(fileIngestBatches)
        .innerJoin(pipelineRuns, eq(pipelineRuns.id, fileIngestBatches.id))
        .where(
          and(
            eq(fileIngestBatches.status, "uploading"),
            lt(fileIngestBatches.expiresAt, now),
          ),
        )
        .limit(100));
      let countExpired = 0;
      for (const row of expired) {
        const changed = yield* db.query((d) => d
          .update(fileIngestBatches)
          .set({
            status: "failed",
            error: UPLOAD_EXPIRED_ERROR,
            completedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(fileIngestBatches.id, row.id),
              eq(fileIngestBatches.status, "uploading"),
            ),
          )
          .returning({ id: fileIngestBatches.id }));
        if (changed.length === 0) continue;
        countExpired += 1;
        yield* db.query((d) => d
          .update(fileIngestFiles)
          .set({
            status: "failed",
            error: UPLOAD_EXPIRED_ERROR,
            completedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(fileIngestFiles.batchId, row.id),
              inArray(fileIngestFiles.status, ["pending", "uploaded"]),
            ),
          ));
        yield* pipeline.updateProgress(
          row.id as Uuid,
          "source_ingest",
          "failed",
          progressSteps(STAGED_FILE_INGEST_STEP_LABELS, "prepare_sources", {
            failed: new Set(["prepare_sources"]),
            details: { prepare_sources: UPLOAD_EXPIRED_ERROR },
          }),
          UPLOAD_EXPIRED_ERROR,
        );
        yield* stagedStorage.clearStagedBatch(row.vaultId as Uuid, row.id as Uuid).pipe(
          Effect.catchCause((cause) =>
            logger.warn("file_ingest.expiry_cleanup_failed", {
              vault_id: row.vaultId,
              batch_id: row.id,
              error: "Cause",
              error_message: Cause.pretty(cause),
            }),
          ),
        );
      }
      return countExpired;
    });

    const dispatchProcessing = Effect.gen(function* () {
      const rows = yield* db.query((d) => d
        .select({ id: fileIngestBatches.id })
        .from(fileIngestBatches)
        .innerJoin(pipelineRuns, eq(pipelineRuns.id, fileIngestBatches.id))
        .where(
          and(
            eq(fileIngestBatches.status, "processing"),
            inArray(pipelineRuns.status, ["pending", "running"]),
          ),
        )
        .orderBy(asc(fileIngestBatches.createdAt))
        .limit(100));
      yield* Effect.forEach(
        rows,
        (row) =>
          Effect.gen(function* () {
            const batch = yield* loadBatch(row.id as Uuid);
            if (batch === undefined || batch.status !== "processing") return;
            const files = yield* loadFiles(batch.id);
            yield* dispatch(batch, files);
          }),
        { concurrency: 4 },
      );
      return rows.length;
    });

    return {
      checkDupes: (userId, vaultId, hashes) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          return yield* sourceDocumentsService.existingClientHashes(vaultId, hashes);
        }),
      create: (userId, vaultId, batchId, inputFiles) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          const manifest = yield* parseFileIngestManifest(inputFiles);
          const now = yield* clock.now;
          const expiresAt = new Date(now.getTime() + UPLOAD_TTL_MS);
          const inserted = yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const runs = yield* tx
                .insert(pipelineRuns)
                .values({
                  id: batchId,
                  vaultId,
                  trigger: "staged_files",
                  status: "running",
                  currentPhase: "source_ingest",
                  phaseStatus: "started",
                  progressSteps: progressSteps(
                    STAGED_FILE_INGEST_STEP_LABELS,
                    "prepare_sources",
                    {
                      counts: {
                        prepare_sources: [0, manifest.length],
                        read_files: [0, manifest.length],
                      },
                    },
                  ),
                })
                .onConflictDoNothing({ target: pipelineRuns.id })
                .returning({ id: pipelineRuns.id });
              if (runs.length === 0) return false;
              const existingSources = yield* tx
                .select({ hash: sourceDocuments.clientHash })
                .from(sourceDocuments)
                .where(
                  and(
                    eq(sourceDocuments.vaultId, vaultId),
                    inArray(
                      sourceDocuments.clientHash,
                      manifest.map((file) => file.hash),
                    ),
                  ),
                );
              const existingHashes = new Set(existingSources.map((source) => source.hash));
              yield* tx.insert(fileIngestBatches).values({
                id: batchId,
                createdBy: userId,
                status: "uploading",
                expiresAt,
              });
              yield* tx.insert(fileIngestFiles).values(
                manifest.map((file, position) => ({
                  batchId,
                  position,
                  hash: file.hash,
                  name: file.name,
                  size: file.size,
                  mimetype: file.mimetype ?? "",
                  needsCompile: !existingHashes.has(file.hash),
                  status: "pending" as const,
                })),
              );
              return true;
            }),
          );
          const batch = yield* loadBatch(batchId);
          if (batch === undefined) {
            return yield* new Conflict({ detail: "Batch ID is already in use" });
          }
          if (batch.vaultId !== vaultId || batch.createdBy !== userId) {
            return yield* new Conflict({ detail: "Batch ID is already in use" });
          }
          const files = yield* loadFiles(batchId);
          if (!inserted && !sameManifest(manifest, files)) {
            return yield* new Conflict({ detail: "Batch ID is bound to a different manifest" });
          }
          return yield* resumableResponse(batch);
        }),
      get: (userId, batchId) =>
        Effect.gen(function* () {
          const batch = yield* requireMemberBatch(userId, batchId);
          return batchResponse(batch, yield* loadFiles(batch.id));
        }),
      resume: (userId, batchId) =>
        Effect.gen(function* () {
          const batch = yield* requireCreatorBatch(userId, batchId);
          return yield* resumableResponse(batch);
        }),
      upload: (userId, batchId, input) =>
        Effect.gen(function* () {
          const batch = yield* requireCreatorBatch(userId, batchId);
          const files = yield* loadFiles(batch.id);
          const file = files.find((candidate) => candidate.hash === input.hash);
          if (file === undefined) {
            return yield* new NotFound({ detail: "File is not in this ingest manifest" });
          }
          if (file.status !== "pending") return;
          if (batch.status !== "uploading") {
            return yield* new BadRequest({ detail: `File ingest is ${batch.status}` });
          }
          if (input.rawBytes.byteLength !== file.size || rawFileHash(input.rawBytes) !== input.hash) {
            return yield* new BadRequest({
              detail: "Uploaded file does not match its manifest",
            });
          }
          if (uploads.kind !== "api") {
            return yield* new BadRequest({
              detail: "Server-mediated upload is unavailable for this storage backend",
            });
          }
          yield* uploads
            .receive(
              batch.vaultId,
              batch.id,
              input.hash,
              input.rawBytes,
              input.contentType,
            )
            .pipe(
              Effect.catchTag("StorageBackendError", (error) =>
                Effect.fail(new BadRequest({ detail: error.message })),
              ),
            );
          yield* markUploaded(batch, input.hash);
        }),
      acknowledge: (userId, batchId, hash) =>
        Effect.gen(function* () {
          const batch = yield* requireCreatorBatch(userId, batchId);
          const files = yield* loadFiles(batch.id);
          const file = files.find((candidate) => candidate.hash === hash);
          if (file === undefined) {
            return yield* new NotFound({ detail: "File is not in this ingest manifest" });
          }
          if (file.status !== "pending") return;
          if (batch.status !== "uploading") {
            return yield* new BadRequest({ detail: `File ingest is ${batch.status}` });
          }
          const exists = yield* stagedStorage
            .stagedExists(batch.vaultId, batch.id, hash)
            .pipe(
              Effect.catchTag("StorageBackendError", (error) =>
                Effect.fail(new BadRequest({ detail: error.message })),
              ),
            );
          if (!exists) {
            return yield* new BadRequest({ detail: "Uploaded file is not available" });
          }
          yield* markUploaded(batch, hash);
        }),
      commit,
      cancel,
      reconcileOnce: () =>
        Effect.gen(function* () {
          const expired = yield* expireUploads;
          const dispatched = yield* dispatchProcessing;
          return { dispatched, expired };
        }),
    } satisfies FileIngestBatchesShape;
  }),
);

export const FileIngestBatchReconcilerLoopLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const batches = yield* FileIngestBatches;
    const logger = yield* StructuredLogger;
    const tick = batches.reconcileOnce().pipe(
      Effect.catchCause((cause) =>
        logger.warn("file_ingest_reconciler_tick_failed", {
          error: "Cause",
          error_message: Cause.pretty(cause),
        }),
      ),
    );
    yield* tick;
    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep("5 seconds").pipe(Effect.andThen(tick))),
    );
  }),
);
