import { zValidator } from "@hono/zod-validator";
import { Effect } from "effect";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  createApiKey,
  listApiKeys,
  refreshAuthTokens,
  requestAuthCode,
  revokeApiKey,
  verifyCode,
} from "@great-minds/core/auth";
import { ApiKeyCreateSchema, ApiKeyIdSchema, AuthCodeSchema, RefreshTokenSecretSchema } from "@great-minds/domain/auth";
import { UserCreateSchema } from "@great-minds/domain/user";
import { z } from "zod";
import { createAuthenticateBearer, currentPrincipal, requireSession } from "../auth.js";
import type { AppEnv } from "../context.js";
import type { ApiRuntime } from "../runtime.js";
import { tokenResponse } from "../schemas/auth.js";

export function createAuthRoutes(runtime: ApiRuntime) {
  const authenticateBearer = createAuthenticateBearer(runtime);

  return new Hono<AppEnv>()
  .post("/request-code", zValidator("json", UserCreateSchema), async (c) => {
    const input = c.req.valid("json");
    return runtime.runPromise(
      requestAuthCode(input).pipe(
        Effect.map(() => c.body(null, 204)),
        Effect.catchTag("AuthCodeDeliveryFailed", (error) =>
          Effect.succeed(c.json({ error: { message: error.message } }, 502)),
        ),
      ),
    );
  })
  .post("/verify-code", zValidator("json", UserCreateSchema.extend({ code: AuthCodeSchema })), async (c) => {
    const body = c.req.valid("json");
    return runtime.runPromise(
      verifyCode(
        { email: body.email },
        body.code,
      ).pipe(
        Effect.map((tokenPair) => c.json(tokenResponse(tokenPair))),
        Effect.catchTag("InvalidAuthCode", () =>
          Effect.fail(new HTTPException(401, { message: "Invalid or expired code" })),
        ),
      ),
    );
  })
  .post("/refresh", zValidator("json", z.object({ refresh_token: RefreshTokenSecretSchema })), async (c) => {
    const body = c.req.valid("json");
    return runtime.runPromise(
      refreshAuthTokens(body.refresh_token).pipe(
        Effect.map((tokenPair) => c.json(tokenResponse(tokenPair))),
        Effect.catchTag("InvalidRefreshToken", () =>
          Effect.fail(new HTTPException(401, { message: "Invalid or expired refresh token" })),
        ),
      ),
    );
  })
  .get("/api-keys", authenticateBearer, requireSession, async (c) => {
    const principal = currentPrincipal(c);
    return runtime.runPromise(
      listApiKeys(principal.user.id).pipe(Effect.map((apiKeys) => c.json(apiKeys))),
    );
  })
  .post("/api-keys", authenticateBearer, requireSession, zValidator("json", ApiKeyCreateSchema), async (c) => {
    const principal = currentPrincipal(c);
    const body = c.req.valid("json");
    return runtime.runPromise(
      createApiKey(principal.user.id, body).pipe(Effect.map((apiKey) => c.json(apiKey, 201))),
    );
  })
  .delete("/api-keys/:id", authenticateBearer, requireSession, zValidator("param", z.object({ id: ApiKeyIdSchema })), async (c) => {
    const principal = currentPrincipal(c);
    const { id } = c.req.valid("param");

    return runtime.runPromise(
      revokeApiKey(principal.user.id, id).pipe(
        Effect.map(() => c.body(null, 204)),
        Effect.catchTag("ApiKeyUnavailable", () =>
          Effect.fail(new HTTPException(404, { message: "API key not found" })),
        ),
      ),
    );
  });
}

