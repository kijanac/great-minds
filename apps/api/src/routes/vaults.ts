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
    c.get("runtime").runPromise(
      getVault(c.get("vaultScope")).pipe(
        Effect.map((vault) => c.json(vault)),
        Effect.catchTag("VaultUnavailable", () =>
          Effect.fail(new HTTPException(404, { message: "Vault not found" })),
        ),
      ),
    ),
  )
  .patch("/", requireScope("vaults:write"), zValidator("json", VaultPatchSchema), async (c) =>
    c.get("runtime").runPromise(
      updateVault(c.get("vaultScope"), c.req.valid("json")).pipe(
        Effect.map((workspace) => c.json(workspace)),
        Effect.catchTags({
          VaultUnavailable: () => Effect.fail(new HTTPException(404, { message: "Vault not found" })),
          VaultForbidden: (error) => Effect.succeed(c.json({ error: { message: error.message } }, 403)),
        }),
      ),
    ),
  )
  .get("/members", requireScope("vaults:read"), async (c) =>
    c.get("runtime").runPromise(
      listVaultMembers(c.get("vaultScope")).pipe(
        Effect.map((members) => c.json({ items: members })),
        Effect.catchTag("VaultUnavailable", () =>
          Effect.fail(new HTTPException(404, { message: "Vault not found" })),
        ),
      ),
    ),
  )
  .get("/stats", requireScope("vaults:read"), async (c) =>
    c.get("runtime").runPromise(
      getVaultStats(c.get("vaultScope")).pipe(
        Effect.map((stats) => c.json(stats)),
        Effect.catchTag("VaultUnavailable", () =>
          Effect.fail(new HTTPException(404, { message: "Vault not found" })),
        ),
      ),
    ),
  )
  .get("/sources", requireScope("sources:read"), zValidator("query", SourceListQuerySchema), async (c) =>
    c.get("runtime").runPromise(
      listSources(c.get("vaultScope"), c.req.valid("query")).pipe(
        Effect.map((page) => c.json(page)),
        Effect.catchTag("VaultUnavailable", () =>
          Effect.fail(new HTTPException(404, { message: "Vault not found" })),
        ),
      ),
    ),
  )
  .post("/sources", requireScope("sources:write"), zValidator("json", SourceDocumentUpsertSchema), async (c) =>
    c.get("runtime").runPromise(
      upsertSourceDocument(c.get("vaultScope"), c.req.valid("json")).pipe(
        Effect.map((source) => c.json(source)),
        Effect.catchTag("VaultUnavailable", () =>
          Effect.fail(new HTTPException(404, { message: "Vault not found" })),
        ),
      ),
    ),
  )
  .post("/query", requireScope("query"), zValidator("json", QueryRequestSchema), async (c) => {
    const requestId = c.get("requestId");
    const providerError = (error: { message: string }) =>
      Effect.succeed(c.json({ error: { message: error.message, requestId } }, 502));

    const response = answerQuery(c.get("vaultScope"), c.req.valid("json")).pipe(
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

    return c.get("runtime").runPromise(response);
  });

export const vaultRoutes = new Hono<AppEnv>()
  .get("/", authenticateBearer, requireScope("vaults:read"), async (c) => {
    const principal = currentPrincipal(c);
    return c.get("runtime").runPromise(
      listVaults(principal.user.id).pipe(Effect.map((vaults) => c.json({ items: vaults }))),
    );
  })
  .post("/", authenticateBearer, requireScope("vaults:write"), zValidator("json", VaultCreateSchema), async (c) => {
    const principal = currentPrincipal(c);
    return c.get("runtime").runPromise(
      createVault(principal.user.id, c.req.valid("json")).pipe(
        Effect.map((workspace) => c.json(workspace, 201)),
        Effect.catchTag("VaultUnavailable", () =>
          Effect.fail(new HTTPException(404, { message: "Vault not found" })),
        ),
      ),
    );
  })
  .route("/:id", vaultScopedRoutes);
