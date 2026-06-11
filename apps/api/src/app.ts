import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import type { ApiConfig, AppEnv } from "./context.js";
import type { ApiRuntime } from "./runtime.js";
import { createAuthRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { createMeRoutes } from "./routes/me.js";
import { createOpenAiRoutes } from "./routes/openai.js";
import { createVaultRoutes } from "./routes/vaults.js";

export function createApp(runtime: ApiRuntime, config: ApiConfig) {
  const app = new Hono<AppEnv>();

  app.use("*", requestId());

  app.route("/health", healthRoutes);
  app.route("/v1", createOpenAiRoutes(runtime, config));
  app.route("/v1", createMeRoutes(runtime));
  app.route("/v1/auth", createAuthRoutes(runtime));
  app.route("/v1/vaults", createVaultRoutes(runtime));

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
