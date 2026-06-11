import { Effect, Layer, ManagedRuntime } from "effect";
import { AuthCodeDelivery, AuthCodeDeliveryFailed, AuthConfig, AuthService, AuthServiceLive } from "@great-minds/core/auth";
import { LlmClient } from "@great-minds/core/llm";
import { openRouterLlmClient } from "@great-minds/core/openrouter";
import { QueryService, QueryServiceLive } from "@great-minds/core/query";
import { createDbLayer, Db, type BackendDbConfig } from "@great-minds/db/context";
import type { ApiConfig } from "./context.js";

export type ApiRuntime = ManagedRuntime.ManagedRuntime<Db | AuthService | QueryService, never>;

export async function createApiRuntime(dbConfig: BackendDbConfig, config: ApiConfig): Promise<ApiRuntime> {
  const dbLayer = createDbLayer(dbConfig);
  const authConfigLayer = Layer.succeed(AuthConfig, AuthConfig.of(config.auth));
  const authCodeDeliveryLayer = Layer.succeed(AuthCodeDelivery, authCodeDelivery(config));
  const llmLayer = Layer.succeed(LlmClient, openRouterLlmClient(config.openAiProvider));
  const authLayer = AuthServiceLive.pipe(Layer.provide(Layer.mergeAll(dbLayer, authConfigLayer, authCodeDeliveryLayer)));
  const queryLayer = QueryServiceLive.pipe(Layer.provide(Layer.mergeAll(dbLayer, llmLayer)));
  const appLayer = Layer.mergeAll(dbLayer, authLayer, queryLayer);
  const runtime = ManagedRuntime.make(appLayer);
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
