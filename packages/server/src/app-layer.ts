import { Database } from "@great-minds/database";
import { Layer } from "effect";

import { AuthService, AuthServiceLive } from "./auth.ts";
import { ClockLive, ClockService } from "./clock.ts";
import { AppConfigLive } from "./config.ts";
import type { AppConfig } from "./config.ts";
import { DrizzleLive } from "./db.ts";
import { StructuredLogger, StructuredLoggerLive } from "./logging.ts";
import { Mailer, MailerLive } from "./mailer.ts";
import { TokenService, TokenServiceLive } from "./tokens.ts";
import { VaultsService, VaultsServiceLive } from "./vaults.ts";

export type AppLayerServices =
  | AppConfig
  | Database
  | ClockService
  | StructuredLogger
  | Mailer
  | TokenService
  | VaultsService
  | AuthService;

export type AppLayerOverrides = {
  readonly config?: Layer.Layer<AppConfig>;
  readonly clock?: Layer.Layer<ClockService>;
  readonly mailer?: Layer.Layer<Mailer>;
  readonly logger?: Layer.Layer<StructuredLogger>;
};

export const makeAppLayer = (overrides: AppLayerOverrides = {}) => {
  const ConfigLive = overrides.config ?? AppConfigLive;
  const BaseLive = Layer.mergeAll(
    DrizzleLive.pipe(Layer.provideMerge(ConfigLive)),
    overrides.clock ?? ClockLive,
    overrides.logger ?? StructuredLoggerLive
  );

  const ServiceDepsLive = Layer.mergeAll(
    overrides.mailer ?? MailerLive,
    TokenServiceLive,
    VaultsServiceLive
  ).pipe(Layer.provideMerge(BaseLive));

  return AuthServiceLive.pipe(Layer.provideMerge(ServiceDepsLive));
};

export const AppLayerLive = makeAppLayer();
