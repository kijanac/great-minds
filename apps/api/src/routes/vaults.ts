import { zValidator } from "@hono/zod-validator";
import { Effect } from "effect";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { LlmClient } from "@great-minds/core/llm";
import { openRouterLlmClient } from "@great-minds/core/openrouter";
import { answerQuery } from "@great-minds/core/query";
import { listSources, upsertSourceDocument } from "@great-minds/core/sources";
import {
  createVault,
  getVault,
  getVaultStats,
  listVaultMembers,
  listVaults,
  updateVault,
} from "@great-minds/core/vaults";
import { QueryRequestSchema } from "@great-minds/domain/query";
import { SourceDocumentUpsertSchema, SourceListQuerySchema } from "@great-minds/domain/source";
import { VaultCreateSchema, VaultIdSchema, VaultPatchSchema } from "@great-minds/domain/vault";
import { authenticateBearer, currentPrincipal, requireScope } from "../auth.js";
import type { AppEnv } from "../context.js";

const bindVaultScope = createMiddleware<AppEnv>(async (c, next) => {
  const principal = currentPrincipal(c);
  const vaultId = VaultIdSchema.parse(c.req.param("id"));

  c.set("vaultScope", { userId: principal.user.id, vaultId });
  await next();
});

const vaultScopedRoutes = new Hono<AppEnv>()
  .use("*", authenticateBearer, bindVaultScope)
  .get("/", requireScope("vaults:read"), async (c) => {
    try {
      const vault = await getVault(c.get("db"), c.get("vaultScope"));
      return c.json(vault);
    } catch {
      throw new HTTPException(404, { message: "Vault not found" });
    }
  })
  .patch("/", requireScope("vaults:write"), zValidator("json", VaultPatchSchema), async (c) => {
    try {
      const workspace = await updateVault(c.get("db"), c.get("vaultScope"), c.req.valid("json"));
      return c.json(workspace);
    } catch {
      throw new HTTPException(404, { message: "Vault not found" });
    }
  })
  .get("/members", requireScope("vaults:read"), async (c) => {
    try {
      const members = await listVaultMembers(c.get("db"), c.get("vaultScope"));
      return c.json({ items: members });
    } catch {
      throw new HTTPException(404, { message: "Vault not found" });
    }
  })
  .get("/stats", requireScope("vaults:read"), async (c) => {
    try {
      const stats = await getVaultStats(c.get("db"), c.get("vaultScope"));
      return c.json(stats);
    } catch {
      throw new HTTPException(404, { message: "Vault not found" });
    }
  })
  .get("/sources", requireScope("sources:read"), zValidator("query", SourceListQuerySchema), async (c) => {
    try {
      const page = await listSources(c.get("db"), c.get("vaultScope"), c.req.valid("query"));
      return c.json(page);
    } catch {
      throw new HTTPException(404, { message: "Vault not found" });
    }
  })
  .post("/sources", requireScope("sources:write"), zValidator("json", SourceDocumentUpsertSchema), async (c) => {
    try {
      const source = await upsertSourceDocument(c.get("db"), c.get("vaultScope"), c.req.valid("json"));
      return c.json(source);
    } catch {
      throw new HTTPException(404, { message: "Vault not found" });
    }
  })
  .post("/query", requireScope("query"), zValidator("json", QueryRequestSchema), async (c) => {
    const response = answerQuery(c.get("db"), c.get("vaultScope"), c.req.valid("json")).pipe(
      Effect.provideService(LlmClient, openRouterLlmClient(c.get("openAiProvider"))),
      Effect.map((answer) => c.json(answer)),
      Effect.catchTag("VaultUnavailable", () =>
        Effect.succeed(c.json({ error: { message: "Vault not found", requestId: c.get("requestId") } }, 404)),
      ),
      Effect.catchAll((error) =>
        Effect.succeed(c.json({ error: { message: error.message, requestId: c.get("requestId") } }, 502)),
      ),
    );

    return Effect.runPromise(response);
  });

export const vaultRoutes = new Hono<AppEnv>()
  .get("/", authenticateBearer, requireScope("vaults:read"), async (c) => {
    const principal = currentPrincipal(c);
    const vaults = await listVaults(c.get("db"), principal.user.id);
    return c.json({ items: vaults });
  })
  .post("/", authenticateBearer, requireScope("vaults:write"), zValidator("json", VaultCreateSchema), async (c) => {
    const principal = currentPrincipal(c);
    const workspace = await createVault(c.get("db"), principal.user.id, c.req.valid("json"));
    return c.json(workspace, 201);
  })
  .route("/:id", vaultScopedRoutes);
