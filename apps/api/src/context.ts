import type { AuthConfigService, AuthenticatedPrincipal, VaultScope } from "@great-minds/core";
import type { OpenRouterConfig } from "./openrouter.js";

export type AuthCodeDeliveryConfig =
  | { kind: "console" }
  | { kind: "resend"; apiKey: string; fromEmail: string };

export type ApiConfig = {
  auth: AuthConfigService;
  authCodeDelivery: AuthCodeDeliveryConfig;
  openAiProvider: OpenRouterConfig;
};

export type AppEnv = {
  Variables: {
    principal?: AuthenticatedPrincipal;
    vaultScope: VaultScope;
    requestId: string;
  };
};
