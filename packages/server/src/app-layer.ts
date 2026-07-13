import { Database } from "@great-minds/database";
import { Layer } from "effect";

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
import { DrizzleLive } from "./db.ts";
import { DocumentsService, DocumentsServiceLive } from "./documents.ts";
import { EmbeddingsLive, EmbeddingsService } from "./embeddings.ts";
import { IngestService, IngestServiceLive } from "./ingest.ts";
import { JobsService, JobsServiceLive } from "./jobs.ts";
import { LintService, LintServiceLive } from "./lint.ts";
import { CostLookupLive, CostLookupService } from "./llm-costs.ts";
import { LanguageModel, LanguageModelLive } from "./llm.ts";
import { StructuredLogger, StructuredLoggerLive } from "./logging.ts";
import { Mailer, MailerLive } from "./mailer.ts";
import { ParallelSearchLive, ParallelSearchService } from "./parallel.ts";
import { PipelineRunsServiceLive } from "./pipeline-runs.ts";
import { ProposalsService, ProposalsServiceLive } from "./proposals.ts";
import { QueryService, QueryServiceLive } from "./query.ts";
import { SessionsService, SessionsServiceLive } from "./sessions.ts";
import { SourceDocumentsService, SourceDocumentsServiceLive } from "./source-documents.ts";
import { StagedFileIngestWorkflowLive } from "./staged-file-ingest-workflow.ts";
import { SourcesService, SourcesServiceLive } from "./sources.ts";
import { ProposalStorage, ProposalStorageLive, VaultStorage, VaultStorageLive } from "./storage.ts";
import { RandomBytesLive, RandomBytesService } from "./random.ts";
import { TokenService, TokenServiceLive } from "./tokens.ts";
import {
  VaultAccessService,
  VaultAccessServiceLive,
  VaultsService,
  VaultsServiceLive,
} from "./vaults.ts";
import { WikiService, WikiServiceLive } from "./wiki.ts";
import { WorkflowEngineLive } from "./workflow-engine.ts";

export type AppLayerServices =
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
  | ProposalsService
  | IngestService
  | JobsService
  | LintService
  | CostsService
  | DocumentsService
  | SessionsService
  | LanguageModel
  | EmbeddingsService
  | CostLookupService
  | ParallelSearchService
  | QueryService
  | VaultStorage
  | ProposalStorage
  | RandomBytesService
  | AuthService;

export type AppLayerOverrides = {
  readonly config?: Layer.Layer<AppConfig>;
  readonly clock?: Layer.Layer<ClockService>;
  readonly mailer?: Layer.Layer<Mailer>;
  readonly logger?: Layer.Layer<StructuredLogger>;
  readonly storage?: Layer.Layer<VaultStorage>;
  readonly proposalStorage?: Layer.Layer<ProposalStorage>;
  readonly randomBytes?: Layer.Layer<RandomBytesService>;
  readonly languageModel?: Layer.Layer<LanguageModel>;
  readonly embeddings?: Layer.Layer<EmbeddingsService>;
  readonly costLookup?: Layer.Layer<CostLookupService>;
  readonly parallelSearch?: Layer.Layer<ParallelSearchService>;
};

export const makeAppLayers = (overrides: AppLayerOverrides = {}) => {
  const ConfigLive = overrides.config ?? AppConfigLive;
  const BaseLive = Layer.mergeAll(
    DrizzleLive.pipe(Layer.provideMerge(ConfigLive)),
    overrides.clock ?? ClockLive,
    overrides.randomBytes ?? RandomBytesLive,
    overrides.logger ?? StructuredLoggerLive,
  );

  const VaultAccessLive = VaultAccessServiceLive.pipe(Layer.provideMerge(BaseLive));
  const StorageLive = (overrides.storage ?? VaultStorageLive).pipe(Layer.provideMerge(BaseLive));
  const ProposalStorageLiveLayer = (overrides.proposalStorage ?? ProposalStorageLive).pipe(
    Layer.provideMerge(BaseLive),
  );
  const LanguageModelLiveLayer = (overrides.languageModel ?? LanguageModelLive).pipe(
    Layer.provideMerge(BaseLive),
  );
  const EmbeddingsLiveLayer = (overrides.embeddings ?? EmbeddingsLive).pipe(
    Layer.provideMerge(BaseLive),
  );
  const CostLookupLiveLayer = (overrides.costLookup ?? CostLookupLive).pipe(
    Layer.provideMerge(BaseLive),
  );
  const ParallelSearchLiveLayer = (overrides.parallelSearch ?? ParallelSearchLive).pipe(
    Layer.provideMerge(BaseLive),
  );
  const MailerLiveLayer = (overrides.mailer ?? MailerLive).pipe(Layer.provideMerge(BaseLive));
  const SourceDocumentsLive = SourceDocumentsServiceLive.pipe(
    Layer.provideMerge(StorageLive),
    Layer.provideMerge(BaseLive),
  );
  const PipelineRunsLive = PipelineRunsServiceLive.pipe(Layer.provideMerge(BaseLive));
  const CompilePhasesLiveLayer = CompilePhasesLive.pipe(
    Layer.provideMerge(LanguageModelLiveLayer),
    Layer.provideMerge(EmbeddingsLiveLayer),
    Layer.provideMerge(PipelineRunsLive),
    Layer.provideMerge(StorageLive),
    Layer.provideMerge(BaseLive),
  );
  const WorkflowEngineBaseLive = WorkflowEngineLive.pipe(Layer.provideMerge(BaseLive));
  const WorkflowHandlersLive = Layer.mergeAll(
    StagedFileIngestWorkflowLive,
    CompileWorkflowLive,
  ).pipe(
    Layer.provideMerge(SourceDocumentsLive),
    Layer.provideMerge(CompilePhasesLiveLayer),
    Layer.provideMerge(PipelineRunsLive),
    Layer.provideMerge(StorageLive),
    Layer.provideMerge(WorkflowEngineBaseLive),
    Layer.provideMerge(BaseLive),
  );
  const WorkflowsLive = WorkflowHandlersLive.pipe(Layer.provideMerge(WorkflowEngineBaseLive));
  const ProposalsLive = ProposalsServiceLive.pipe(
    Layer.provideMerge(SourceDocumentsLive),
    Layer.provideMerge(ProposalStorageLiveLayer),
    Layer.provideMerge(StorageLive),
    Layer.provideMerge(VaultAccessLive),
    Layer.provideMerge(BaseLive),
  );
  const SourcesLive = SourcesServiceLive.pipe(
    Layer.provideMerge(ProposalsLive),
    Layer.provideMerge(SourceDocumentsLive),
    Layer.provideMerge(VaultAccessLive),
    Layer.provideMerge(BaseLive),
  );
  const IngestLive = IngestServiceLive.pipe(
    Layer.provideMerge(ProposalsLive),
    Layer.provideMerge(SourceDocumentsLive),
    Layer.provideMerge(StorageLive),
    Layer.provideMerge(VaultAccessLive),
    Layer.provideMerge(WorkflowsLive),
    Layer.provideMerge(BaseLive),
  );
  const JobsLive = JobsServiceLive.pipe(
    Layer.provideMerge(PipelineRunsLive),
    Layer.provideMerge(WorkflowsLive),
    Layer.provideMerge(VaultAccessLive),
    Layer.provideMerge(BaseLive),
  );
  const LintLive = LintServiceLive.pipe(
    Layer.provideMerge(VaultAccessLive),
    Layer.provideMerge(BaseLive),
  );
  const CostsLive = CostsServiceLive.pipe(
    Layer.provideMerge(VaultAccessLive),
    Layer.provideMerge(BaseLive),
  );
  const VaultsLive = VaultsServiceLive.pipe(
    Layer.provideMerge(MailerLiveLayer),
    Layer.provideMerge(VaultAccessLive),
    Layer.provideMerge(StorageLive),
    Layer.provideMerge(BaseLive),
  );
  const ReadServicesLive = Layer.mergeAll(
    VaultsLive,
    WikiServiceLive.pipe(Layer.provideMerge(VaultAccessLive), Layer.provideMerge(BaseLive)),
    SourcesLive,
    IngestLive,
    JobsLive,
    LintLive,
    CostsLive,
    DocumentsServiceLive.pipe(
      Layer.provideMerge(VaultAccessLive),
      Layer.provideMerge(StorageLive),
      Layer.provideMerge(BaseLive),
    ),
    SessionsServiceLive.pipe(
      Layer.provideMerge(VaultAccessLive),
      Layer.provideMerge(StorageLive),
      Layer.provideMerge(IngestLive),
      Layer.provideMerge(ProposalsLive),
      Layer.provideMerge(SourceDocumentsLive),
      Layer.provideMerge(BaseLive),
    ),
    QueryServiceLive.pipe(
      Layer.provideMerge(LanguageModelLiveLayer),
      Layer.provideMerge(EmbeddingsLiveLayer),
      Layer.provideMerge(CostLookupLiveLayer),
      Layer.provideMerge(ParallelSearchLiveLayer),
      Layer.provideMerge(VaultAccessLive),
      Layer.provideMerge(StorageLive),
      Layer.provideMerge(BaseLive),
    ),
    SourceDocumentsLive,
    ProposalsLive,
    ProposalStorageLiveLayer,
  );

  const ServiceDepsLive = Layer.mergeAll(
    MailerLiveLayer,
    TokenServiceLive,
    StorageLive,
    LanguageModelLiveLayer,
    EmbeddingsLiveLayer,
    CostLookupLiveLayer,
    ParallelSearchLiveLayer,
    ReadServicesLive,
  ).pipe(Layer.provideMerge(BaseLive));

  const ApiLive = AuthServiceLive.pipe(Layer.provideMerge(ServiceDepsLive));
  const AppLive = ApiLive.pipe(
    Layer.provideMerge(WorkflowsLive),
    Layer.provideMerge(PipelineRunsLive),
    Layer.provideMerge(BaseLive),
  );
  const ReconcilerLive = CompileIntentReconcilerLive.pipe(
    Layer.provideMerge(PipelineRunsLive),
    Layer.provideMerge(WorkflowsLive),
    Layer.provideMerge(BaseLive),
  );
  const ReconcilerLoopLive = CompileIntentReconcilerLoopLive.pipe(
    Layer.provideMerge(ReconcilerLive),
    Layer.provideMerge(WorkflowsLive),
    Layer.provideMerge(BaseLive),
  );
  return { app: AppLive, reconcilerLoop: ReconcilerLoopLive } as const;
};

export const makeAppLayer = (overrides: AppLayerOverrides = {}) => makeAppLayers(overrides).app;

export const AppLayerLive = makeAppLayer();
