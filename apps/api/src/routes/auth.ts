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
import { authenticateBearer, currentPrincipal, requireSession } from "../auth.js";
import type { AppEnv, AuthCodeDeliveryConfig } from "../context.js";
import { tokenResponse } from "../schemas/auth.js";

export const authRoutes = new Hono<AppEnv>()
  .post("/request-code", zValidator("json", UserCreateSchema), async (c) => {
    const input = c.req.valid("json");
    return Effect.runPromise(
      requestAuthCode(c.get("db"), input, c.get("authConfig"), (email, code) =>
        deliverAuthCode(
          c.get("authCodeDelivery"),
          email,
          code,
          c.get("authConfig").authCodeExpiryMinutes,
        ),
      ).pipe(
        Effect.map(() => c.body(null, 204)),
        Effect.catchTag("AuthCodeDeliveryFailed", (error) =>
          Effect.succeed(c.json({ error: { message: error.message } }, 502)),
        ),
      ),
    );
  })
  .post("/verify-code", zValidator("json", UserCreateSchema.extend({ code: AuthCodeSchema })), async (c) => {
    const body = c.req.valid("json");
    return Effect.runPromise(
      verifyCode(
        c.get("db"),
        { email: body.email },
        body.code,
        c.get("authConfig"),
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
    return Effect.runPromise(
      refreshAuthTokens(c.get("db"), body.refresh_token, c.get("authConfig")).pipe(
        Effect.map((tokenPair) => c.json(tokenResponse(tokenPair))),
        Effect.catchTag("InvalidRefreshToken", () =>
          Effect.fail(new HTTPException(401, { message: "Invalid or expired refresh token" })),
        ),
      ),
    );
  })
  .get("/api-keys", authenticateBearer, requireSession, async (c) => {
    const principal = currentPrincipal(c);
    return Effect.runPromise(
      listApiKeys(c.get("db"), principal.user.id).pipe(Effect.map((apiKeys) => c.json(apiKeys))),
    );
  })
  .post("/api-keys", authenticateBearer, requireSession, zValidator("json", ApiKeyCreateSchema), async (c) => {
    const principal = currentPrincipal(c);
    const body = c.req.valid("json");
    return Effect.runPromise(
      createApiKey(c.get("db"), principal.user.id, body).pipe(Effect.map((apiKey) => c.json(apiKey, 201))),
    );
  })
  .delete("/api-keys/:id", authenticateBearer, requireSession, zValidator("param", z.object({ id: ApiKeyIdSchema })), async (c) => {
    const principal = currentPrincipal(c);
    const { id } = c.req.valid("param");

    return Effect.runPromise(
      revokeApiKey(c.get("db"), principal.user.id, id).pipe(
        Effect.map(() => c.body(null, 204)),
        Effect.catchTag("ApiKeyUnavailable", () =>
          Effect.fail(new HTTPException(404, { message: "API key not found" })),
        ),
      ),
    );
  });

async function deliverAuthCode(
  delivery: AuthCodeDeliveryConfig,
  email: string,
  code: string,
  expiresInMinutes: number,
): Promise<void> {
  if (delivery.kind === "console") {
    console.warn(`Auth code for ${email}: ${code}`);
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
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
  });

  if (!response.ok) throw new Error("Failed to send auth code");
}

