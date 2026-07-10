import { Database } from "@great-minds/database";
import { Layer } from "effect";

import { AuthService, AuthServiceLive } from "./auth.ts";
import { ClockLive, ClockService } from "./clock.ts";
import { AppConfigLive } from "./config.ts";
import type { AppConfig } from "./config.ts";
import { DrizzleLive } from "./db.ts";
import { DocumentsService, DocumentsServiceLive } from "./documents.ts";
import { IngestService, IngestServiceLive } from "./ingest.ts";
import { StructuredLogger, StructuredLoggerLive } from "./logging.ts";
import { Mailer, MailerLive } from "./mailer.ts";
import { ProposalsService, ProposalsServiceLive } from "./proposals.ts";
import { SessionsService, SessionsServiceLive } from "./sessions.ts";
import { SourceDocumentsService, SourceDocumentsServiceLive } from "./source-documents.ts";
import { SourcesService, SourcesServiceLive } from "./sources.ts";
import { ProposalStorage, ProposalStorageLive, VaultStorage, VaultStorageLive } from "./storage.ts";
import { TokenService, TokenServiceLive } from "./tokens.ts";
import {
  VaultAccessService,
  VaultAccessServiceLive,
  VaultsService,
  VaultsServiceLive,
} from "./vaults.ts";
import { WikiService, WikiServiceLive } from "./wiki.ts";

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
  | DocumentsService
  | SessionsService
  | VaultStorage
  | ProposalStorage
  | AuthService;

export type AppLayerOverrides = {
  readonly config?: Layer.Layer<AppConfig>;
  readonly clock?: Layer.Layer<ClockService>;
  readonly mailer?: Layer.Layer<Mailer>;
  readonly logger?: Layer.Layer<StructuredLogger>;
  readonly storage?: Layer.Layer<VaultStorage>;
  readonly proposalStorage?: Layer.Layer<ProposalStorage>;
};

export const makeAppLayer = (overrides: AppLayerOverrides = {}) => {
  const ConfigLive = overrides.config ?? AppConfigLive;
  const BaseLive = Layer.mergeAll(
    DrizzleLive.pipe(Layer.provideMerge(ConfigLive)),
    overrides.clock ?? ClockLive,
    overrides.logger ?? StructuredLoggerLive,
  );

  const VaultAccessLive = VaultAccessServiceLive.pipe(Layer.provideMerge(BaseLive));
  const StorageLive = (overrides.storage ?? VaultStorageLive).pipe(Layer.provideMerge(BaseLive));
  const ProposalStorageLiveLayer = (overrides.proposalStorage ?? ProposalStorageLive).pipe(
    Layer.provideMerge(BaseLive),
  );
  const MailerLiveLayer = (overrides.mailer ?? MailerLive).pipe(Layer.provideMerge(BaseLive));
  const SourceDocumentsLive = SourceDocumentsServiceLive.pipe(
    Layer.provideMerge(StorageLive),
    Layer.provideMerge(BaseLive),
  );
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
    DocumentsServiceLive.pipe(
      Layer.provideMerge(VaultAccessLive),
      Layer.provideMerge(StorageLive),
      Layer.provideMerge(BaseLive),
    ),
    SessionsServiceLive.pipe(
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
    ReadServicesLive,
  ).pipe(Layer.provideMerge(BaseLive));

  return AuthServiceLive.pipe(Layer.provideMerge(ServiceDepsLive));
};

export const AppLayerLive = makeAppLayer();
