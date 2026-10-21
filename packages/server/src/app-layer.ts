import { Database, DatabaseLive } from "@great-minds/database";
import { Effect, Layer } from "effect";
import type { WorkflowEngine } from "effect/unstable/workflow/WorkflowEngine";

import { AuthService, AuthServiceLive } from "./auth.ts";
import {
  CompileIntentReconcilerLive,
  CompileIntentReconcilerLoopLive,
  CompileWorkflowLive,
} from "./compile-intents.ts";
import { ClockLive, ClockService } from "./clock.ts";
import { CompilePhasesLive } from "./compile-phases.ts";
import { AppConfigLive } from "./config.ts";
import type { AppConfig } from "./config.ts";
import { CostsService, CostsServiceLive } from "./costs.ts";
import { ReplyAdmission, ReplyAdmissionLive } from "./conversation-history/admission.ts";
import { ReplySettlement, ReplySettlementLive } from "./conversation-history/settlement.ts";
import { HistoryStore, type HistoryStoreShape } from "./conversation-history/store.ts";
import { PgClientLive } from "./db.ts";
import { DocumentsService, DocumentsServiceLive } from "./documents.ts";
import { EmbeddingsLive, EmbeddingsService } from "./embeddings.ts";
import {
  FileIngestBatchReconcilerLoopLive,
  FileIngestBatches,
  FileIngestBatchesLive,
} from "./file-ingest-batches.ts";
import { IngestService, IngestServiceLive } from "./ingest.ts";
import { JobsService, JobsServiceLive } from "./jobs.ts";
import { LintService, LintServiceLive } from "./lint.ts";
import { CostLookupLive, CostLookupService } from "./llm-costs.ts";
import { LanguageModel, LanguageModelLive } from "./llm.ts";
import { StructuredLogger, StructuredLoggerLive } from "./logging.ts";
import { Mailer, MailerLive } from "./mailer.ts";
import { ParallelSearchLive, ParallelSearchService } from "./parallel.ts";
import { PasskeysService, PasskeysServiceLive } from "./passkeys.ts";
import { PipelineRunsServiceLive } from "./pipeline-runs.ts";
import {
  ProposalReviewReconcilerLoopLive,
  ProposalsService,
  ProposalsServiceLive,
} from "./proposals.ts";
import { QueryService, QueryServiceLive } from "./query.ts";
import {
  RepliesService,
  RepliesServiceLive,
  ReplyReconcilerLoopLive,
  ReplyWorkflowLive,
} from "./replies.ts";
import { SessionsService, SessionsServiceLive } from "./sessions.ts";
import { PdfRenderer, PdfRendererLive } from "./publication/pdf.ts";
import { SessionExportsService, SessionExportsServiceLive } from "./publication/service.ts";
import { SharesService, SharesServiceLive } from "./shares.ts";
import {
  SourceDeletionReconcilerLoopLive,
  SourceDocumentsService,
  SourceDocumentsServiceLive,
} from "./source-documents.ts";
import { StagedFileIngestWorkflowLive } from "./staged-file-ingest-workflow.ts";
import { SourcesService, SourcesServiceLive } from "./sources.ts";
import {
  ContentStorage,
  ContentStorageLive,
  HistoryStoreLive,
  ProposalStorage,
  ProposalStorageLive,
  StagedStorage,
  StagedStorageLive,
  StagedUploadGateway,
  StagedUploadGatewayLive,
  StorageBackendLive,
  StorageMaintenanceLoopLive,
} from "./storage.ts";
import { RandomBytesLive, RandomBytesService } from "./random.ts";
import { TokenService, TokenServiceLive } from "./tokens.ts";
import { UserDocumentsService, UserDocumentsServiceLive } from "./user-documents.ts";
import {
  VaultAccessService,
  VaultAccessServiceLive,
  VaultsService,
  VaultsServiceLive,
} from "./vaults.ts";
import { WikiService, WikiServiceLive } from "./wiki.ts";
import {
  UrlIngestReconcilerLoopLive,
  UrlIngestService,
  UrlIngestServiceLive,
} from "./url-ingest.ts";
import { UrlIngestWorkflowLive } from "./url-ingest-workflow.ts";
import { WorkflowEngineLive } from "./workflow-engine.ts";

export type AppLayerServices =
  | WorkflowEngine
  | AppConfig
  | Database
  | ClockService
  | StructuredLogger
  | Mailer
  | TokenService
  | VaultAccessService
  | VaultsService
  | WikiService
  | SourcesService
  | SourceDocumentsService
  | UserDocumentsService
  | ProposalsService
  | IngestService
  | UrlIngestService
  | FileIngestBatches
  | JobsService
  | LintService
  | CostsService
  | DocumentsService
  | SessionsService
  | SessionExportsService
  | PdfRenderer
  | SharesService
  | LanguageModel
  | EmbeddingsService
  | CostLookupService
  | ParallelSearchService
  | QueryService
  | RepliesService
  | ReplyAdmission
  | ReplySettlement
  | HistoryStore
  | ContentStorage
  | StagedStorage
  | StagedUploadGateway
  | ProposalStorage
  | RandomBytesService
  | AuthService
  | PasskeysService;

export type AppLayerOverrides = {
  readonly config?: Layer.Layer<AppConfig>;
  readonly decorateHistory?: (histories: HistoryStoreShape) => HistoryStoreShape;
  readonly pdfRenderer?: Layer.Layer<PdfRenderer>;
  readonly clock?: Layer.Layer<ClockService>;
  readonly mailer?: Layer.Layer<Mailer>;
  readonly logger?: Layer.Layer<StructuredLogger>;
  readonly randomBytes?: Layer.Layer<RandomBytesService>;
  readonly languageModel?: Layer.Layer<LanguageModel>;
  readonly embeddings?: Layer.Layer<EmbeddingsService>;
  readonly costLookup?: Layer.Layer<CostLookupService>;
  readonly parallelSearch?: Layer.Layer<ParallelSearchService>;
};

export const makeAppLayers = (overrides: AppLayerOverrides = {}) => {
  const PostgresLive = Layer.mergeAll(DatabaseLive, WorkflowEngineLive).pipe(
    Layer.provide(PgClientLive),
  );
  const InfrastructureLive = Layer.mergeAll(
    PostgresLive,
    overrides.clock ?? ClockLive,
    overrides.randomBytes ?? RandomBytesLive,
    overrides.logger ?? StructuredLoggerLive,
  ).pipe(Layer.provideMerge(overrides.config ?? AppConfigLive));

  const HistoriesLive = Layer.effect(
    HistoryStore,
    Effect.map(HistoryStore, (histories) =>
      overrides.decorateHistory === undefined ? histories : overrides.decorateHistory(histories),
    ),
  ).pipe(Layer.provide(HistoryStoreLive));
  const StorageLive = Layer.mergeAll(
    ContentStorageLive,
    StagedStorageLive,
    StagedUploadGatewayLive,
    ProposalStorageLive,
    HistoriesLive,
  ).pipe(Layer.provide(StorageBackendLive));
  const AdaptersLive = Layer.mergeAll(
    StorageLive,
    overrides.mailer ?? MailerLive,
    overrides.pdfRenderer ?? PdfRendererLive,
    overrides.languageModel ?? LanguageModelLive,
    overrides.embeddings ?? EmbeddingsLive,
    overrides.costLookup ?? CostLookupLive,
    overrides.parallelSearch ?? ParallelSearchLive,
  ).pipe(Layer.provideMerge(InfrastructureLive));

  const ServicesLive = Layer.mergeAll(
    RepliesServiceLive,
    SharesServiceLive,
    SessionExportsServiceLive,
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(SessionsServiceLive, PasskeysServiceLive)),
    Layer.provideMerge(
      Layer.mergeAll(SourcesServiceLive, IngestServiceLive, JobsServiceLive, AuthServiceLive),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        ProposalsServiceLive,
        VaultsServiceLive,
        WikiServiceLive,
        LintServiceLive,
        CostsServiceLive,
        DocumentsServiceLive,
        FileIngestBatchesLive,
        UrlIngestServiceLive,
        CompilePhasesLive,
        ReplyAdmissionLive,
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        VaultAccessServiceLive,
        PipelineRunsServiceLive,
        SourceDocumentsServiceLive,
        UserDocumentsServiceLive,
        TokenServiceLive,
        QueryServiceLive,
        ReplySettlementLive,
      ),
    ),
    Layer.provideMerge(AdaptersLive),
  );

  const AppLive = Layer.mergeAll(
    StagedFileIngestWorkflowLive,
    UrlIngestWorkflowLive,
    CompileWorkflowLive,
    ReplyWorkflowLive,
  ).pipe(Layer.provideMerge(ServicesLive));

  const ReconcilerLoopLive = Layer.mergeAll(
    CompileIntentReconcilerLoopLive,
    FileIngestBatchReconcilerLoopLive,
    UrlIngestReconcilerLoopLive,
    ReplyReconcilerLoopLive,
    SourceDeletionReconcilerLoopLive,
    ProposalReviewReconcilerLoopLive,
    StorageMaintenanceLoopLive,
  ).pipe(
    Layer.provide(CompileIntentReconcilerLive),
    Layer.provide(StorageBackendLive),
    Layer.provide(AppLive),
  );
  return { app: AppLive, reconcilerLoop: ReconcilerLoopLive } as const;
};

export const makeAppLayer = (overrides: AppLayerOverrides = {}) => makeAppLayers(overrides).app;

export const AppLayerLive = makeAppLayer();
