import { Hono } from "hono";
import { createAuthenticateBearer, currentPrincipal, requirePrincipal } from "../auth.js";
import type { BackendRuntime } from "@great-minds/db/context";
import type { ApiConfig, AppEnv } from "../context.js";

export function createMeRoutes(runtime: BackendRuntime, config: ApiConfig) {
  const authenticateBearer = createAuthenticateBearer(runtime, config.auth);

  return new Hono<AppEnv>().get("/me", authenticateBearer, requirePrincipal, (c) =>
    c.json(currentPrincipal(c)),
  );
}
