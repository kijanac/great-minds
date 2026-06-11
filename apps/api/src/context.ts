import type { AuthConfig, AuthenticatedPrincipal } from "@great-minds/core/auth";
import type { OpenRouterConfig } from "@great-minds/core/openrouter";
import type { VaultScope } from "@great-minds/core/workspace";

export type AuthCodeDeliveryConfig =
  | { kind: "console" }
  | { kind: "resend"; apiKey: string; fromEmail: string };

export type ApiConfig = {
  auth: AuthConfig;
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
