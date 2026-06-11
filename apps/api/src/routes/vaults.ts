import { zValidator } from "@hono/zod-validator";
import { Effect } from "effect";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { QueryService } from "@great-minds/core/query";
import { SourceService } from "@great-minds/core/sources";
import { VaultService } from "@great-minds/core/vaults";
import { QueryRequestSchema } from "@great-minds/domain/query";
import { SourceDocumentUpsertSchema, SourceListQuerySchema } from "@great-minds/domain/source";
import { VaultCreateSchema, VaultIdSchema, VaultPatchSchema } from "@great-minds/domain/vault";
import { createAuthenticateBearer, currentPrincipal, requireScope } from "../auth.js";
import type { AppEnv } from "../context.js";
import type { ApiRuntime } from "../runtime.js";

const bindVaultScope = createMiddleware<AppEnv>(async (c, next) => {
  const principal = currentPrincipal(c);
  const vaultId = VaultIdSchema.parse(c.req.param("id"));

  c.set("vaultScope", { userId: principal.user.id, vaultId });
  await next();
});

function createVaultScopedRoutes(runtime: ApiRuntime, authenticateBearer: ReturnType<typeof createAuthenticateBearer>) {
  return new Hono<AppEnv>()
  .use("*", authenticateBearer, bindVaultScope)
  .get("/", requireScope("vaults:read"), async (c) =>
    runtime.runPromise(
      Effect.flatMap(VaultService, (vaults) => vaults.getVault(c.get("vaultScope"))).pipe(
        Effect.map((vault) => c.json(vault)),
        Effect.catchTag("VaultUnavailable", () =>
          Effect.fail(new HTTPException(404, { message: "Vault not found" })),
        ),
      ),
    ),
  )
  .patch("/", requireScope("vaults:write"), zValidator("json", VaultPatchSchema), async (c) =>
    runtime.runPromise(
      Effect.flatMap(VaultService, (vaults) => vaults.updateVault(c.get("vaultScope"), c.req.valid("json"))).pipe(
        Effect.map((workspace) => c.json(workspace)),
        Effect.catchTags({
          VaultUnavailable: () => Effect.fail(new HTTPException(404, { message: "Vault not found" })),
          VaultForbidden: (error) => Effect.succeed(c.json({ error: { message: error.message } }, 403)),
        }),
      ),
    ),
  )
  .get("/members", requireScope("vaults:read"), async (c) =>
    runtime.runPromise(
      Effect.flatMap(VaultService, (vaults) => vaults.listMembers(c.get("vaultScope"))).pipe(
        Effect.map((members) => c.json({ items: members })),
        Effect.catchTag("VaultUnavailable", () =>
          Effect.fail(new HTTPException(404, { message: "Vault not found" })),
        ),
      ),
    ),
  )
  .get("/stats", requireScope("vaults:read"), async (c) =>
    runtime.runPromise(
      Effect.flatMap(VaultService, (vaults) => vaults.getStats(c.get("vaultScope"))).pipe(
        Effect.map((stats) => c.json(stats)),
        Effect.catchTag("VaultUnavailable", () =>
          Effect.fail(new HTTPException(404, { message: "Vault not found" })),
        ),
      ),
    ),
  )
  .get("/sources", requireScope("sources:read"), zValidator("query", SourceListQuerySchema), async (c) =>
    runtime.runPromise(
      Effect.flatMap(SourceService, (sources) => sources.listSources(c.get("vaultScope"), c.req.valid("query"))).pipe(
        Effect.map((page) => c.json(page)),
        Effect.catchTag("VaultUnavailable", () =>
          Effect.fail(new HTTPException(404, { message: "Vault not found" })),
        ),
      ),
    ),
  )
  .post("/sources", requireScope("sources:write"), zValidator("json", SourceDocumentUpsertSchema), async (c) =>
    runtime.runPromise(
      Effect.flatMap(SourceService, (sources) => sources.upsertSourceDocument(c.get("vaultScope"), c.req.valid("json"))).pipe(
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

    const response = Effect.gen(function* () {
      const queries = yield* QueryService;
      const answer = yield* queries.answer(c.get("vaultScope"), c.req.valid("json"));
      return c.json(answer);
    }).pipe(
      Effect.catchTags({
        VaultUnavailable: () => Effect.succeed(c.json({ error: { message: "Vault not found", requestId } }, 404)),
        LlmRateLimited: providerError,
        LlmUnavailable: providerError,
        LlmRejected: providerError,
        LlmBadResponse: providerError,
      }),
    );

    return runtime.runPromise(response);
  });
}

export function createVaultRoutes(runtime: ApiRuntime) {
  const authenticateBearer = createAuthenticateBearer(runtime);

  return new Hono<AppEnv>()
  .get("/", authenticateBearer, requireScope("vaults:read"), async (c) => {
    const principal = currentPrincipal(c);
    return runtime.runPromise(
      Effect.flatMap(VaultService, (vaults) => vaults.listVaults(principal.user.id)).pipe(Effect.map((vaults) => c.json({ items: vaults }))),
    );
  })
  .post("/", authenticateBearer, requireScope("vaults:write"), zValidator("json", VaultCreateSchema), async (c) => {
    const principal = currentPrincipal(c);
    return runtime.runPromise(
      Effect.flatMap(VaultService, (vaults) => vaults.createVault(principal.user.id, c.req.valid("json"))).pipe(
        Effect.map((workspace) => c.json(workspace, 201)),
      ),
    );
  })
  .route("/:id", createVaultScopedRoutes(runtime, authenticateBearer));
}
