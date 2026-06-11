import { Effect } from "effect";
import type { Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { AuthService } from "@great-minds/core/auth";
import type { ApiKeyScope } from "@great-minds/domain/auth";
import type { AppEnv } from "./context.js";
import type { ApiRuntime } from "./runtime.js";

export function createAuthenticateBearer(runtime: ApiRuntime) {
  return bearerAuth({
    verifyToken: async (token, c) => {
      const principal = await runtime.runPromise(
        Effect.flatMap(AuthService, (auth) => auth.resolveBearerToken(token)),
      );
      if (!principal) return false;

      c.set("principal", principal);
      return true;
    },
  });
}

export const requirePrincipal = createMiddleware<AppEnv>(async (c, next) => {
  currentPrincipal(c);
  await next();
});

export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const principal = currentPrincipal(c);
  if (principal.credential.kind !== "session") {
    throw new HTTPException(403, { message: "User session required" });
  }

  await next();
});

export function requireScope(scope: ApiKeyScope) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const principal = currentPrincipal(c);
    if (principal.credential.kind === "session" || principal.credential.scopes.includes(scope)) {
      await next();
      return;
    }

    throw new HTTPException(403, { message: "Insufficient API key scope" });
  });
}

export const requireApiKey = createMiddleware<AppEnv>(async (c, next) => {
  const principal = currentPrincipal(c);
  if (principal.credential.kind !== "apiKey") {
    throw new HTTPException(403, { message: "API key required" });
  }

  await next();
});

export function requireApiKeyScope(scope: ApiKeyScope) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const principal = currentPrincipal(c);
    if (principal.credential.kind === "apiKey" && principal.credential.scopes.includes(scope)) {
      await next();
      return;
    }

    throw new HTTPException(403, { message: "API key with required scope required" });
  });
}

export function currentPrincipal(c: Context<AppEnv>) {
  const principal = c.get("principal");
  if (!principal) throw new HTTPException(401, { message: "Authentication required" });
  return principal;
}
