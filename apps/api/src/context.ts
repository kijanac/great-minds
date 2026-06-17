import type { AuthConfigService, AuthenticatedPrincipal, VaultScope } from "@great-minds/core";
import type { OpenRouterConfig } from "./openrouter.js";

export type AuthCodeDeliveryConfig =
  | { kind: "console" }
  | { kind: "resend"; apiKey: string; fromEmail: string };

export type StorageConfig =
  | { kind: "local"; dataDir: string }
  | {
      kind: "r2";
      accountId: string;
      accessKeyId: string;
      secretAccessKey: string;
      bucketPrefix: string;
    };

export type ApiConfig = {
  auth: AuthConfigService;
  authCodeDelivery: AuthCodeDeliveryConfig;
  openAiProvider: OpenRouterConfig;
  storage: StorageConfig;
};

export type AppEnv = {
  Variables: {
    principal?: AuthenticatedPrincipal;
    vaultScope: VaultScope;
    requestId: string;
  };
};
