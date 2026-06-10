import type { AuthConfig, AuthenticatedPrincipal } from "@great-minds/core/auth";
import type { VaultScope } from "@great-minds/core/workspace";
import type { BackendDb } from "@great-minds/db/context";

export type AuthCodeDeliveryConfig =
  | { kind: "console" }
  | { kind: "resend"; apiKey: string; fromEmail: string };

export type OpenAiProviderConfig =
  | { kind: "disabled" }
  | {
      kind: "openrouter";
      apiKey: string;
      baseUrl: string;
      appName?: string;
      siteUrl?: string;
    };

export type ApiConfig = {
  auth: AuthConfig;
  authCodeDelivery: AuthCodeDeliveryConfig;
  openAiProvider: OpenAiProviderConfig;
};

export type AppEnv = {
  Variables: {
    db: BackendDb;
    authConfig: AuthConfig;
    authCodeDelivery: AuthCodeDeliveryConfig;
    openAiProvider: OpenAiProviderConfig;
    principal?: AuthenticatedPrincipal;
    vaultScope: VaultScope;
    requestId: string;
  };
};
