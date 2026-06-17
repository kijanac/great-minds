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
  VaultStorage,
  authServiceLayer,
  queryServiceLayer,
  sourceServiceLayer,
  vaultServiceLayer,
  type AuthCodeDeliveryService,
  type AuthConfigService,
  type LlmClientService,
  type VaultStorageService,
} from "@great-minds/core";
import { openRouterLlmClient } from "./openrouter.js";
import { createDbLayer, Db, type BackendDbConfig } from "@great-minds/db/context";
import type { ApiConfig } from "./context.js";
import { createMailer } from "./mailer.js";
import { createVaultStorage } from "./storage.js";

export type ApiRuntime = ManagedRuntime.ManagedRuntime<
  AuthService | QueryService | SourceService | VaultService,
  never
>;

export type ApiLayerOptions = {
  readonly dbLayer: Layer.Layer<Db, never>;
  readonly authConfig: AuthConfigService;
  readonly authCodeDelivery: AuthCodeDeliveryService;
  readonly llmClient: LlmClientService;
  readonly vaultStorage: VaultStorageService;
};

export function createApiLayer(options: ApiLayerOptions) {
  const authConfigLayer = Layer.succeed(AuthConfig, AuthConfig.of(options.authConfig));
  const authCodeDeliveryLayer = Layer.succeed(
    AuthCodeDelivery,
    AuthCodeDelivery.of(options.authCodeDelivery),
  );
  const llmLayer = Layer.succeed(LlmClient, LlmClient.of(options.llmClient));
  const vaultStorageLayer = Layer.succeed(VaultStorage, VaultStorage.of(options.vaultStorage));
  const authLayer = authServiceLayer.pipe(
    Layer.provide(Layer.mergeAll(options.dbLayer, authConfigLayer, authCodeDeliveryLayer)),
  );
  const queryLayer = queryServiceLayer.pipe(
    Layer.provide(Layer.mergeAll(options.dbLayer, llmLayer)),
  );
  const sourceLayer = sourceServiceLayer.pipe(
    Layer.provide(Layer.mergeAll(options.dbLayer, vaultStorageLayer)),
  );
  const vaultLayer = vaultServiceLayer.pipe(
    Layer.provide(Layer.mergeAll(options.dbLayer, vaultStorageLayer)),
  );
  return Layer.mergeAll(options.dbLayer, authLayer, queryLayer, sourceLayer, vaultLayer);
}

export async function createApiRuntime(
  dbConfig: BackendDbConfig,
  config: ApiConfig,
): Promise<ApiRuntime> {
  const runtime = ManagedRuntime.make(
    createApiLayer({
      dbLayer: createDbLayer(dbConfig),
      authConfig: config.auth,
      authCodeDelivery: authCodeDelivery(config),
      llmClient: openRouterLlmClient(config.openAiProvider),
      vaultStorage: createVaultStorage(config.storage),
    }),
  );
  await runtime.runPromise(Db);
  return runtime;
}

function authCodeDelivery(config: ApiConfig) {
  const mailer = createMailer(config.authCodeDelivery);
  return AuthCodeDelivery.of({
    deliver: (email, code, expiresInMinutes) =>
      mailer
        .send({
          to: email,
          subject: "Your sign-in code",
          text: `Your Great Minds sign-in code is: ${code}\n\nExpires in ${expiresInMinutes} minutes.`,
        })
        .pipe(
          Effect.catchTag("MailDeliveryFailed", () =>
            Effect.fail(new AuthCodeDeliveryFailed({ message: "Failed to send auth code" })),
          ),
        ),
  });
}
