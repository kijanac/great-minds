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
  .get("/", requireScope("vaults:read"), async (c) =>
    Effect.runPromise(
      getVault(c.get("db"), c.get("vaultScope")).pipe(
        Effect.map((vault) => c.json(vault)),
        Effect.catchTags({
          VaultUnavailable: () => Effect.fail(new HTTPException(404, { message: "Vault not found" })),
          VaultPersistenceFailed: (error) => Effect.succeed(c.json({ error: { message: error.message } }, 500)),
        }),
      ),
    ),
  )
  .patch("/", requireScope("vaults:write"), zValidator("json", VaultPatchSchema), async (c) =>
    Effect.runPromise(
      updateVault(c.get("db"), c.get("vaultScope"), c.req.valid("json")).pipe(
        Effect.map((workspace) => c.json(workspace)),
        Effect.catchTags({
          VaultUnavailable: () => Effect.fail(new HTTPException(404, { message: "Vault not found" })),
          VaultForbidden: (error) => Effect.succeed(c.json({ error: { message: error.message } }, 403)),
          VaultPersistenceFailed: (error) => Effect.succeed(c.json({ error: { message: error.message } }, 500)),
        }),
      ),
    ),
  )
  .get("/members", requireScope("vaults:read"), async (c) =>
    Effect.runPromise(
      listVaultMembers(c.get("db"), c.get("vaultScope")).pipe(
        Effect.map((members) => c.json({ items: members })),
        Effect.catchTags({
          VaultUnavailable: () => Effect.fail(new HTTPException(404, { message: "Vault not found" })),
          VaultPersistenceFailed: (error) => Effect.succeed(c.json({ error: { message: error.message } }, 500)),
        }),
      ),
    ),
  )
  .get("/stats", requireScope("vaults:read"), async (c) =>
    Effect.runPromise(
      getVaultStats(c.get("db"), c.get("vaultScope")).pipe(
        Effect.map((stats) => c.json(stats)),
        Effect.catchTags({
          VaultUnavailable: () => Effect.fail(new HTTPException(404, { message: "Vault not found" })),
          VaultPersistenceFailed: (error) => Effect.succeed(c.json({ error: { message: error.message } }, 500)),
        }),
      ),
    ),
  )
  .get("/sources", requireScope("sources:read"), zValidator("query", SourceListQuerySchema), async (c) =>
    Effect.runPromise(
      listSources(c.get("db"), c.get("vaultScope"), c.req.valid("query")).pipe(
        Effect.map((page) => c.json(page)),
        Effect.catchTags({
          VaultUnavailable: () => Effect.fail(new HTTPException(404, { message: "Vault not found" })),
          SourcePersistenceFailed: (error) => Effect.succeed(c.json({ error: { message: error.message } }, 500)),
        }),
      ),
    ),
  )
  .post("/sources", requireScope("sources:write"), zValidator("json", SourceDocumentUpsertSchema), async (c) =>
    Effect.runPromise(
      upsertSourceDocument(c.get("db"), c.get("vaultScope"), c.req.valid("json")).pipe(
        Effect.map((source) => c.json(source)),
        Effect.catchTags({
          VaultUnavailable: () => Effect.fail(new HTTPException(404, { message: "Vault not found" })),
          SourcePersistenceFailed: (error) => Effect.succeed(c.json({ error: { message: error.message } }, 500)),
        }),
      ),
    ),
  )
  .post("/query", requireScope("query"), zValidator("json", QueryRequestSchema), async (c) => {
    const requestId = c.get("requestId");
    const providerError = (error: { message: string }) =>
      Effect.succeed(c.json({ error: { message: error.message, requestId } }, 502));

    const response = answerQuery(c.get("db"), c.get("vaultScope"), c.req.valid("json")).pipe(
      Effect.provideService(LlmClient, openRouterLlmClient(c.get("openAiProvider"))),
      Effect.map((answer) => c.json(answer)),
      Effect.catchTags({
        VaultUnavailable: () => Effect.succeed(c.json({ error: { message: "Vault not found", requestId } }, 404)),
        LlmRateLimited: providerError,
        LlmUnavailable: providerError,
        LlmRejected: providerError,
        LlmBadResponse: providerError,
      }),
    );

    return Effect.runPromise(response);
  });

export const vaultRoutes = new Hono<AppEnv>()
  .get("/", authenticateBearer, requireScope("vaults:read"), async (c) => {
    const principal = currentPrincipal(c);
    return Effect.runPromise(
      listVaults(c.get("db"), principal.user.id).pipe(
        Effect.map((vaults) => c.json({ items: vaults })),
        Effect.catchTag("VaultPersistenceFailed", (error) =>
          Effect.succeed(c.json({ error: { message: error.message } }, 500)),
        ),
      ),
    );
  })
  .post("/", authenticateBearer, requireScope("vaults:write"), zValidator("json", VaultCreateSchema), async (c) => {
    const principal = currentPrincipal(c);
    return Effect.runPromise(
      createVault(c.get("db"), principal.user.id, c.req.valid("json")).pipe(
        Effect.map((workspace) => c.json(workspace, 201)),
        Effect.catchTags({
          VaultUnavailable: () => Effect.fail(new HTTPException(404, { message: "Vault not found" })),
          VaultPersistenceFailed: (error) => Effect.succeed(c.json({ error: { message: error.message } }, 500)),
        }),
      ),
    );
  })
  .route("/:id", vaultScopedRoutes);
