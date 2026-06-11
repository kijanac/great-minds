import { Hono } from "hono";
import { createAuthenticateBearer, currentPrincipal, requirePrincipal } from "../auth.js";
import type { ApiConfig, AppEnv } from "../context.js";
import type { ApiRuntime } from "../runtime.js";

export function createMeRoutes(runtime: ApiRuntime, config: ApiConfig) {
  const authenticateBearer = createAuthenticateBearer(runtime, config.auth);

  return new Hono<AppEnv>().get("/me", authenticateBearer, requirePrincipal, (c) =>
    c.json(currentPrincipal(c)),
  );
}
