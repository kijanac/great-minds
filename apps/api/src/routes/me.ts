import { Hono } from "hono";
import { createAuthenticateBearer, currentPrincipal, requirePrincipal } from "../auth.js";
import type { AppEnv } from "../context.js";
import type { ApiRuntime } from "../runtime.js";

export function createMeRoutes(runtime: ApiRuntime) {
  const authenticateBearer = createAuthenticateBearer(runtime);

  return new Hono<AppEnv>().get("/me", authenticateBearer, requirePrincipal, (c) =>
    c.json(currentPrincipal(c)),
  );
}
