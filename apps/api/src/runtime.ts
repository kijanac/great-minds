import { Effect, Layer, ManagedRuntime } from "effect";
import {
  AuthCodeDelivery,
  AuthCodeDeliveryFailed,
  AuthConfig,
  AuthService,
  LlmClient,
  QueryService,
  SourceService,
  VaultService,
  authServiceLayer,
  queryServiceLayer,
  sourceServiceLayer,
  vaultServiceLayer,
  type AuthCodeDeliveryService,
  type AuthConfigService,
  type LlmClientService,
} from "@great-minds/core";
import { openRouterLlmClient } from "@great-minds/core/openrouter";
import { createDbLayer, Db, type BackendDbConfig } from "@great-minds/db/context";
import type { ApiConfig } from "./context.js";

export type ApiRuntime = ManagedRuntime.ManagedRuntime<AuthService | QueryService | SourceService | VaultService, never>;

export type ApiLayerOptions = {
  readonly dbLayer: Layer.Layer<Db, never>;
  readonly authConfig: AuthConfigService;
  readonly authCodeDelivery: AuthCodeDeliveryService;
  readonly llmClient: LlmClientService;
};

export function createApiLayer(options: ApiLayerOptions) {
  const authConfigLayer = Layer.succeed(AuthConfig, AuthConfig.of(options.authConfig));
  const authCodeDeliveryLayer = Layer.succeed(AuthCodeDelivery, AuthCodeDelivery.of(options.authCodeDelivery));
  const llmLayer = Layer.succeed(LlmClient, LlmClient.of(options.llmClient));
  const authLayer = authServiceLayer.pipe(Layer.provide(Layer.mergeAll(options.dbLayer, authConfigLayer, authCodeDeliveryLayer)));
  const queryLayer = queryServiceLayer.pipe(Layer.provide(Layer.mergeAll(options.dbLayer, llmLayer)));
  const sourceLayer = sourceServiceLayer.pipe(Layer.provide(options.dbLayer));
  const vaultLayer = vaultServiceLayer.pipe(Layer.provide(options.dbLayer));
  return Layer.mergeAll(options.dbLayer, authLayer, queryLayer, sourceLayer, vaultLayer);
}

export async function createApiRuntime(dbConfig: BackendDbConfig, config: ApiConfig): Promise<ApiRuntime> {
  const runtime = ManagedRuntime.make(
    createApiLayer({
      dbLayer: createDbLayer(dbConfig),
      authConfig: config.auth,
      authCodeDelivery: authCodeDelivery(config),
      llmClient: openRouterLlmClient(config.openAiProvider),
    }),
  );
  await runtime.runPromise(Db);
  return runtime;
}

function authCodeDelivery(config: ApiConfig) {
  return AuthCodeDelivery.of({
    deliver: (email, code, expiresInMinutes) => {
      const delivery = config.authCodeDelivery;
      if (delivery.kind === "console") {
        return Effect.sync(() => console.warn(`Auth code for ${email}: ${code}`));
      }

      return Effect.tryPromise({
        try: () =>
          fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${delivery.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: delivery.fromEmail,
              to: [email],
              subject: "Your sign-in code",
              text: `Your Great Minds sign-in code is: ${code}\n\nExpires in ${expiresInMinutes} minutes.`,
            }),
          }).then((response) => {
            if (!response.ok) throw new Error("Failed to send auth code");
          }),
        catch: () => new AuthCodeDeliveryFailed({ message: "Failed to send auth code" }),
      });
    },
  });
}
