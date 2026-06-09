import { zValidator } from "@hono/zod-validator";
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
    await requestAuthCode(c.get("db"), input, c.get("authConfig"), (email, code) =>
      deliverAuthCode(
        c.get("authCodeDelivery"),
        email,
        code,
        c.get("authConfig").authCodeExpiryMinutes,
      ),
    );
    return c.body(null, 204);
  })
  .post("/verify-code", zValidator("json", UserCreateSchema.extend({ code: AuthCodeSchema })), async (c) => {
    const body = c.req.valid("json");
    try {
      const tokenPair = await verifyCode(
        c.get("db"),
        { email: body.email },
        body.code,
        c.get("authConfig"),
      );
      return c.json(tokenResponse(tokenPair));
    } catch {
      throw new HTTPException(401, { message: "Invalid or expired code" });
    }
  })
  .post("/refresh", zValidator("json", z.object({ refresh_token: RefreshTokenSecretSchema })), async (c) => {
    const body = c.req.valid("json");
    try {
      const tokenPair = await refreshAuthTokens(c.get("db"), body.refresh_token, c.get("authConfig"));
      return c.json(tokenResponse(tokenPair));
    } catch {
      throw new HTTPException(401, { message: "Invalid or expired refresh token" });
    }
  })
  .get("/api-keys", authenticateBearer, requireSession, async (c) => {
    const principal = currentPrincipal(c);
    const apiKeys = await listApiKeys(c.get("db"), principal.user.id);
    return c.json(apiKeys);
  })
  .post("/api-keys", authenticateBearer, requireSession, zValidator("json", ApiKeyCreateSchema), async (c) => {
    const principal = currentPrincipal(c);
    const body = c.req.valid("json");
    const apiKey = await createApiKey(c.get("db"), principal.user.id, body);
    return c.json(apiKey, 201);
  })
  .delete("/api-keys/:id", authenticateBearer, requireSession, zValidator("param", z.object({ id: ApiKeyIdSchema })), async (c) => {
    const principal = currentPrincipal(c);
    const { id } = c.req.valid("param");

    try {
      await revokeApiKey(c.get("db"), principal.user.id, id);
    } catch {
      throw new HTTPException(404, { message: "API key not found" });
    }
    return c.body(null, 204);
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

