import { zValidator } from "@hono/zod-validator";
import { Effect } from "effect";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { QueryService, SourceService, VaultService } from "@great-minds/core";
import { QueryRequestSchema } from "@great-minds/domain/query";
import {
  SourceDocumentCreateSchema,
  SourceDocumentDeleteSchema,
  SourceListQuerySchema,
} from "@great-minds/domain/source";
import { UserIdSchema } from "@great-minds/domain/user";
import {
  VaultCreateCommandSchema,
  VaultIdSchema,
  VaultMemberInviteSchema,
  VaultMemberUpdateSchema,
  VaultPatchSchema,
} from "@great-minds/domain/vault";
import { z } from "zod";
import { createAuthenticateBearer, currentPrincipal, requireScope } from "../auth.js";
import type { ApiConfig, AppEnv } from "../context.js";
import { createMailer } from "../mailer.js";
import type { ApiRuntime } from "../runtime.js";

const bindVaultScope = createMiddleware<AppEnv>(async (c, next) => {
  const principal = currentPrincipal(c);
  const vaultId = VaultIdSchema.parse(c.req.param("id"));

  c.set("vaultScope", { userId: principal.user.id, vaultId });
  await next();
});

function createVaultScopedRoutes(
  runtime: ApiRuntime,
  config: ApiConfig,
  authenticateBearer: ReturnType<typeof createAuthenticateBearer>,
) {
  const mailer = createMailer(config.authCodeDelivery);
  return new Hono<AppEnv>()
    .use("*", authenticateBearer, bindVaultScope)
    .get("/", requireScope("vaults:read"), async (c) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const vaults = yield* VaultService;
          const vault = yield* vaults.getVault(c.get("vaultScope"));
          return c.json(vault);
        }).pipe(
          Effect.catchTag("VaultUnavailable", () =>
            Effect.fail(new HTTPException(404, { message: "Vault not found" })),
          ),
        ),
      ),
    )
    .patch("/", requireScope("vaults:write"), zValidator("json", VaultPatchSchema), async (c) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const vaults = yield* VaultService;
          const workspace = yield* vaults.updateVault(c.get("vaultScope"), c.req.valid("json"));
          return c.json(workspace);
        }).pipe(
          Effect.catchTags({
            VaultUnavailable: () =>
              Effect.fail(new HTTPException(404, { message: "Vault not found" })),
            VaultForbidden: (error) =>
              Effect.succeed(c.json({ error: { message: error.message } }, 403)),
          }),
        ),
      ),
    )
    .get("/members", requireScope("vaults:read"), async (c) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const vaults = yield* VaultService;
          const members = yield* vaults.listMembers(c.get("vaultScope"));
          return c.json({ items: members });
        }).pipe(
          Effect.catchTags({
            VaultUnavailable: () =>
              Effect.fail(new HTTPException(404, { message: "Vault not found" })),
            VaultForbidden: (error) =>
              Effect.succeed(c.json({ error: { message: error.message } }, 403)),
          }),
        ),
      ),
    )
    .post(
      "/members",
      requireScope("vaults:write"),
      zValidator("json", VaultMemberInviteSchema),
      async (c) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const principal = currentPrincipal(c);
            const vaults = yield* VaultService;
            const vault = yield* vaults.getVault(c.get("vaultScope"));
            const member = yield* vaults.inviteMember(c.get("vaultScope"), c.req.valid("json"));
            yield* mailer.send({
              to: member.user.email,
              subject: `You've been invited to ${vault.name}`,
              text: `${principal.user.email} invited you to the project "${vault.name}" on Great Minds as ${member.role}.\n\nSign in at https://greatmind.dev to access it.`,
            });
            return c.json(member, 201);
          }).pipe(
            Effect.catchTags({
              VaultUnavailable: () =>
                Effect.fail(new HTTPException(404, { message: "Vault not found" })),
              VaultForbidden: (error) =>
                Effect.succeed(c.json({ error: { message: error.message } }, 403)),
              VaultMemberAlreadyExists: (error) =>
                Effect.succeed(c.json({ error: { message: error.message } }, 409)),
              MailDeliveryFailed: (error) =>
                Effect.succeed(c.json({ error: { message: error.message } }, 502)),
            }),
          ),
        ),
    )
    .put(
      "/members/:memberUserId",
      requireScope("vaults:write"),
      zValidator("param", z.object({ memberUserId: UserIdSchema })),
      zValidator("json", VaultMemberUpdateSchema),
      async (c) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const vaults = yield* VaultService;
            const member = yield* vaults.updateMember(
              c.get("vaultScope"),
              c.req.valid("param").memberUserId,
              c.req.valid("json"),
            );
            return c.json(member);
          }).pipe(
            Effect.catchTags({
              UserUnavailable: () =>
                Effect.fail(new HTTPException(404, { message: "User not found" })),
              VaultUnavailable: () =>
                Effect.fail(new HTTPException(404, { message: "Vault not found" })),
              VaultMemberUnavailable: () =>
                Effect.fail(new HTTPException(404, { message: "Membership not found" })),
              VaultForbidden: (error) =>
                Effect.succeed(c.json({ error: { message: error.message } }, 403)),
            }),
          ),
        ),
    )
    .delete(
      "/members/:memberUserId",
      requireScope("vaults:write"),
      zValidator("param", z.object({ memberUserId: UserIdSchema })),
      async (c) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const vaults = yield* VaultService;
            yield* vaults.removeMember(c.get("vaultScope"), c.req.valid("param").memberUserId);
            return c.body(null, 204);
          }).pipe(
            Effect.catchTags({
              VaultUnavailable: () =>
                Effect.fail(new HTTPException(404, { message: "Vault not found" })),
              VaultMemberUnavailable: () =>
                Effect.fail(new HTTPException(404, { message: "Membership not found" })),
              VaultForbidden: (error) =>
                Effect.succeed(c.json({ error: { message: error.message } }, 403)),
            }),
          ),
        ),
    )
    .get("/stats", requireScope("vaults:read"), async (c) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const vaults = yield* VaultService;
          const stats = yield* vaults.getStats(c.get("vaultScope"));
          return c.json(stats);
        }).pipe(
          Effect.catchTag("VaultUnavailable", () =>
            Effect.fail(new HTTPException(404, { message: "Vault not found" })),
          ),
        ),
      ),
    )
    .get(
      "/sources",
      requireScope("sources:read"),
      zValidator("query", SourceListQuerySchema),
      async (c) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const sources = yield* SourceService;
            const page = yield* sources.listSources(c.get("vaultScope"), c.req.valid("query"));
            return c.json(page);
          }).pipe(
            Effect.catchTag("VaultUnavailable", () =>
              Effect.fail(new HTTPException(404, { message: "Vault not found" })),
            ),
          ),
        ),
    )
    .post(
      "/sources",
      requireScope("sources:write"),
      zValidator("json", SourceDocumentCreateSchema),
      async (c) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const sources = yield* SourceService;
            const source = yield* sources.createSourceDocument(
              c.get("vaultScope"),
              c.req.valid("json"),
            );
            return c.json(source);
          }).pipe(
            Effect.catchTags({
              VaultUnavailable: () =>
                Effect.fail(new HTTPException(404, { message: "Vault not found" })),
              StorageOperationFailed: (error) =>
                Effect.succeed(c.json({ error: { message: error.message } }, 500)),
            }),
          ),
        ),
    )
    .delete(
      "/sources",
      requireScope("sources:write"),
      zValidator("query", SourceDocumentDeleteSchema),
      async (c) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const sources = yield* SourceService;
            yield* sources.deleteSourceDocument(c.get("vaultScope"), c.req.valid("query"));
            return c.body(null, 204);
          }).pipe(
            Effect.catchTags({
              SourceDocumentUnavailable: (error) =>
                Effect.succeed(c.json({ error: { message: error.message } }, 404)),
              VaultUnavailable: () =>
                Effect.fail(new HTTPException(404, { message: "Vault not found" })),
              VaultForbidden: (error) =>
                Effect.succeed(c.json({ error: { message: error.message } }, 403)),
              StorageOperationFailed: (error) =>
                Effect.succeed(c.json({ error: { message: error.message } }, 500)),
            }),
          ),
        ),
    )
    .delete("/", requireScope("vaults:write"), async (c) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const vaults = yield* VaultService;
          yield* vaults.deleteVault(c.get("vaultScope"));
          return c.body(null, 204);
        }).pipe(
          Effect.catchTags({
            VaultUnavailable: () =>
              Effect.fail(new HTTPException(404, { message: "Vault not found" })),
            VaultForbidden: (error) =>
              Effect.succeed(c.json({ error: { message: error.message } }, 403)),
            StorageOperationFailed: (error) =>
              Effect.succeed(c.json({ error: { message: error.message } }, 500)),
          }),
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
          VaultUnavailable: () =>
            Effect.succeed(c.json({ error: { message: "Vault not found", requestId } }, 404)),
          LlmRateLimited: providerError,
          LlmUnavailable: providerError,
          LlmRejected: providerError,
          LlmBadResponse: providerError,
        }),
      );

      return runtime.runPromise(response);
    });
}

export function createVaultRoutes(runtime: ApiRuntime, config: ApiConfig) {
  const authenticateBearer = createAuthenticateBearer(runtime);

  return new Hono<AppEnv>()
    .get("/", authenticateBearer, requireScope("vaults:read"), async (c) => {
      const principal = currentPrincipal(c);
      return runtime.runPromise(
        Effect.gen(function* () {
          const vaults = yield* VaultService;
          const items = yield* vaults.listVaults(principal.user.id);
          return c.json({ items });
        }),
      );
    })
    .post(
      "/",
      authenticateBearer,
      requireScope("vaults:write"),
      zValidator("json", VaultCreateCommandSchema),
      async (c) => {
        const principal = currentPrincipal(c);
        return runtime.runPromise(
          Effect.gen(function* () {
            const vaults = yield* VaultService;
            const workspace = yield* vaults.createVault(principal.user.id, c.req.valid("json"));
            return c.json(workspace, 201);
          }).pipe(
            Effect.catchTag("StorageOperationFailed", (error) =>
              Effect.succeed(c.json({ error: { message: error.message } }, 500)),
            ),
          ),
        );
      },
    )
    .route("/:id", createVaultScopedRoutes(runtime, config, authenticateBearer));
}
