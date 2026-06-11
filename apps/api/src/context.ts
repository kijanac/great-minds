import type { AuthConfig, AuthenticatedPrincipal } from "@great-minds/core/auth";
import type { OpenRouterConfig } from "@great-minds/core/openrouter";
import type { VaultScope } from "@great-minds/core/workspace";
import type { BackendRuntime } from "@great-minds/db/context";

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
    runtime: BackendRuntime;
    authConfig: AuthConfig;
    authCodeDelivery: AuthCodeDeliveryConfig;
    openAiProvider: OpenRouterConfig;
    principal?: AuthenticatedPrincipal;
    vaultScope: VaultScope;
    requestId: string;
  };
};
