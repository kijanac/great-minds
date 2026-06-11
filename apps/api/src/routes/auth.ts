import { zValidator } from "@hono/zod-validator";
import { Effect } from "effect";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { AuthService } from "@great-minds/core/auth";
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
      Effect.gen(function* () {
        const auth = yield* AuthService;
        yield* auth.requestCode(input);
        return c.body(null, 204);
      }).pipe(
        Effect.catchTag("AuthCodeDeliveryFailed", (error) =>
          Effect.succeed(c.json({ error: { message: error.message } }, 502)),
        ),
      ),
    );
  })
  .post("/verify-code", zValidator("json", UserCreateSchema.extend({ code: AuthCodeSchema })), async (c) => {
    const body = c.req.valid("json");
    return runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        const tokenPair = yield* auth.verifyCode({ email: body.email }, body.code);
        return c.json(tokenResponse(tokenPair));
      }).pipe(
        Effect.catchTag("InvalidAuthCode", () =>
          Effect.fail(new HTTPException(401, { message: "Invalid or expired code" })),
        ),
      ),
    );
  })
  .post("/refresh", zValidator("json", z.object({ refresh_token: RefreshTokenSecretSchema })), async (c) => {
    const body = c.req.valid("json");
    return runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        const tokenPair = yield* auth.refreshTokens(body.refresh_token);
        return c.json(tokenResponse(tokenPair));
      }).pipe(
        Effect.catchTag("InvalidRefreshToken", () =>
          Effect.fail(new HTTPException(401, { message: "Invalid or expired refresh token" })),
        ),
      ),
    );
  })
  .get("/api-keys", authenticateBearer, requireSession, async (c) => {
    const principal = currentPrincipal(c);
    return runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        const apiKeys = yield* auth.listApiKeys(principal.user.id);
        return c.json(apiKeys);
      }),
    );
  })
  .post("/api-keys", authenticateBearer, requireSession, zValidator("json", ApiKeyCreateSchema), async (c) => {
    const principal = currentPrincipal(c);
    const body = c.req.valid("json");
    return runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        const apiKey = yield* auth.createApiKey(principal.user.id, body);
        return c.json(apiKey, 201);
      }),
    );
  })
  .delete("/api-keys/:id", authenticateBearer, requireSession, zValidator("param", z.object({ id: ApiKeyIdSchema })), async (c) => {
    const principal = currentPrincipal(c);
    const { id } = c.req.valid("param");

    return runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        yield* auth.revokeApiKey(principal.user.id, id);
        return c.body(null, 204);
      }).pipe(
        Effect.catchTag("ApiKeyUnavailable", () =>
          Effect.fail(new HTTPException(404, { message: "API key not found" })),
        ),
      ),
    );
  });
}

