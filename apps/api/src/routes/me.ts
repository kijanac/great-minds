import { Hono } from "hono";
import { authenticateBearer, currentPrincipal, requirePrincipal } from "../auth.js";
import type { AppEnv } from "../context.js";

export const meRoutes = new Hono<AppEnv>().get("/me", authenticateBearer, requirePrincipal, (c) =>
  c.json(currentPrincipal(c)),
);
