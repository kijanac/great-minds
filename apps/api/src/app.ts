import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import type { BackendRuntime } from "@great-minds/db/context";
import type { ApiConfig, AppEnv } from "./context.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { meRoutes } from "./routes/me.js";
import { openAiRoutes } from "./routes/openai.js";
import { vaultRoutes } from "./routes/vaults.js";

export function createApp(runtime: BackendRuntime, config: ApiConfig) {
  const app = new Hono<AppEnv>();

  app.use("*", requestId());
  app.use("*", async (c, next) => {
    c.set("runtime", runtime);
    c.set("authConfig", config.auth);
    c.set("authCodeDelivery", config.authCodeDelivery);
    c.set("openAiProvider", config.openAiProvider);
    await next();
  });

  app.route("/health", healthRoutes);
  app.route("/v1", openAiRoutes);
  app.route("/v1", meRoutes);
  app.route("/v1/auth", authRoutes);
  app.route("/v1/vaults", vaultRoutes);

  app.notFound((c) =>
    c.json(
      { error: { message: "Not found", requestId: c.get("requestId") } },
      404,
    ),
  );

  app.onError((error, c) => {
    const requestId = c.get("requestId");

    if (error instanceof HTTPException) {
      return c.json({ error: { message: error.message, requestId } }, error.status);
    }

    console.error(error);
    return c.json({ error: { message: "Internal server error", requestId } }, 500);
  });

  return app;
}
