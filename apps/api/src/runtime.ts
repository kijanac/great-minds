import { Effect, Layer, ManagedRuntime } from "effect";
import { AuthCodeDelivery, AuthCodeDeliveryFailed, AuthConfig } from "@great-minds/core/auth";
import { LlmClient } from "@great-minds/core/llm";
import { openRouterLlmClient } from "@great-minds/core/openrouter";
import { createDbLayer, Db, type BackendDbConfig } from "@great-minds/db/context";
import type { ApiConfig } from "./context.js";

export type ApiRuntime = ManagedRuntime.ManagedRuntime<Db | LlmClient | AuthCodeDelivery | AuthConfig, never>;

export async function createApiRuntime(dbConfig: BackendDbConfig, config: ApiConfig): Promise<ApiRuntime> {
  const appLayer = createDbLayer(dbConfig).pipe(
    Layer.merge(Layer.succeed(AuthConfig, AuthConfig.of(config.auth))),
    Layer.merge(Layer.succeed(LlmClient, openRouterLlmClient(config.openAiProvider))),
    Layer.merge(Layer.succeed(AuthCodeDelivery, authCodeDelivery(config))),
  );
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
