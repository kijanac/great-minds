import { randomUUID } from "node:crypto";

import { Database, users, vaultMemberships, vaults, wikiArticles } from "@great-minds/database";
import {
  Email,
  Forbidden,
  type MemberPage,
  type MemberRole,
  type PageParams,
  type Uuid,
  type VaultConfig,
  type VaultDetail,
  type VaultPage,
} from "@great-minds/domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { parse as parseYaml } from "yaml";

import { pageEnvelope, oneTotal } from "./pagination.ts";
import { VaultStorage } from "./storage.ts";

type CountRow = {
  readonly count: number;
};

type DbMemberRole = typeof vaultMemberships.$inferSelect.role;

type VaultScope = {
  readonly vaultId: Uuid;
  readonly userId: Uuid;
  readonly role: MemberRole;
};

export type VaultAccessServiceShape = {
  readonly requireMember: (
    userId: Uuid,
    vaultId: Uuid,
    detail?: string,
  ) => Effect.Effect<VaultScope, Forbidden>;
  readonly requireOwner: (userId: Uuid, vaultId: Uuid) => Effect.Effect<VaultScope, Forbidden>;
};

export type VaultsServiceShape = {
  readonly ensureDefaultForUser: (userId: Uuid, email: Email) => Effect.Effect<void>;
  readonly deleteOwnedVaults: (userId: Uuid) => Effect.Effect<void>;
  readonly listVaults: (userId: Uuid, params: PageParams) => Effect.Effect<VaultPage>;
  readonly getVaultDetail: (userId: Uuid, vaultId: Uuid) => Effect.Effect<VaultDetail, Forbidden>;
  readonly getVaultConfig: (userId: Uuid, vaultId: Uuid) => Effect.Effect<VaultConfig, Forbidden>;
  readonly listMembers: (
    userId: Uuid,
    vaultId: Uuid,
    params: PageParams,
  ) => Effect.Effect<MemberPage, Forbidden>;
};

export class VaultAccessService extends Context.Service<
  VaultAccessService,
  VaultAccessServiceShape
>()("@great-minds/server/VaultAccessService") {}

export class VaultsService extends Context.Service<VaultsService, VaultsServiceShape>()(
  "@great-minds/server/VaultsService",
) {}

const defaultVaultConfig = {
  thematic_hint: "",
  kinds: ["person", "event", "organization", "concept"],
} satisfies VaultConfig;

const CONFIG_PATH = "config.yaml";

const VaultConfigYaml = Schema.Struct({
  thematic_hint: Schema.optionalKey(Schema.NullOr(Schema.String)),
  kinds: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});

const decodeVaultConfigYaml = Schema.decodeUnknownEffect(VaultConfigYaml);

const parseVaultConfig = (content: string) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parseYaml(content) as unknown,
      catch: (error) => error,
    }).pipe(Effect.orDie);
    const decoded = yield* decodeVaultConfigYaml(parsed ?? {}).pipe(Effect.orDie);
    return {
      thematic_hint: decoded.thematic_hint ?? defaultVaultConfig.thematic_hint,
      kinds:
        decoded.kinds !== undefined && decoded.kinds !== null && decoded.kinds.length > 0
          ? decoded.kinds
          : defaultVaultConfig.kinds,
    } satisfies VaultConfig;
  });

const asUuid = (value: string): Uuid => value as Uuid;

const asEmail = (value: string): Email => value as Email;

const roleFromDb = (role: DbMemberRole): MemberRole => {
  switch (role) {
    case "OWNER":
      return "owner";
    case "EDITOR":
      return "editor";
    case "VIEWER":
      return "viewer";
  }
};

const vaultResponse = (row: {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  readonly createdAt: Date;
  readonly r2BucketName: string | null;
}) => ({
  id: asUuid(row.id),
  name: row.name,
  owner_id: asUuid(row.ownerId),
  created_at: row.createdAt.toISOString(),
  r2_bucket_name: row.r2BucketName,
});

const oneCount = (rows: readonly CountRow[]) => {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("count query returned no rows");
  }
  return row.count;
};

export const VaultAccessServiceLive = Layer.effect(
  VaultAccessService,
  Effect.gen(function* () {
    const db = yield* Database;

    const requireMember = (
      userId: Uuid,
      vaultId: Uuid,
      detail = "Only vault members can perform this action",
    ) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select({ role: vaultMemberships.role })
          .from(vaultMemberships)
          .where(and(eq(vaultMemberships.userId, userId), eq(vaultMemberships.vaultId, vaultId)))
          .limit(1)
          .pipe(Effect.orDie);
        const row = rows[0];
        if (row === undefined) {
          return yield* new Forbidden({ detail });
        }
        return {
          vaultId,
          userId,
          role: roleFromDb(row.role),
        };
      });

    return {
      requireMember,
      requireOwner: (userId, vaultId) =>
        Effect.gen(function* () {
          const scope = yield* requireMember(
            userId,
            vaultId,
            "Only vault owners can perform this action",
          );
          if (scope.role !== "owner") {
            return yield* new Forbidden({
              detail: "Only vault owners can perform this action",
            });
          }
          return scope;
        }),
    } satisfies VaultAccessServiceShape;
  }),
);

export const VaultsServiceLive = Layer.effect(
  VaultsService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;
    const storage = yield* VaultStorage;
    return {
      ensureDefaultForUser: (userId, email) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              const membershipCounts = yield* tx
                .select({ count: sql<number>`count(*)::int` })
                .from(vaultMemberships)
                .where(eq(vaultMemberships.userId, userId));
              if (oneCount(membershipCounts) > 0) {
                return;
              }

              const vaultId = randomUUID();
              yield* tx.insert(vaults).values({
                id: vaultId,
                name: `${email}'s vault`,
                ownerId: userId,
              });
              yield* tx.insert(vaultMemberships).values({
                id: randomUUID(),
                vaultId,
                userId,
                role: "OWNER",
              });
            }),
          )
          .pipe(Effect.orDie),
      deleteOwnedVaults: (userId) =>
        db.delete(vaults).where(eq(vaults.ownerId, userId)).pipe(Effect.orDie),
      listVaults: (userId, params) =>
        Effect.gen(function* () {
          const countRows = yield* db
            .select({ total: sql<number>`count(*)::int` })
            .from(vaultMemberships)
            .where(eq(vaultMemberships.userId, userId))
            .pipe(Effect.orDie);
          const rows = yield* db
            .select({
              id: vaults.id,
              name: vaults.name,
              ownerId: vaults.ownerId,
              createdAt: vaults.createdAt,
              r2BucketName: vaults.r2BucketName,
              role: vaultMemberships.role,
            })
            .from(vaultMemberships)
            .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
            .where(eq(vaultMemberships.userId, userId))
            .orderBy(desc(vaults.createdAt))
            .limit(params.limit)
            .offset(params.offset)
            .pipe(Effect.orDie);

          return {
            ...pageEnvelope(
              rows.map((row) => vaultResponse(row)),
              params,
              oneTotal(countRows),
            ),
            roles: Object.fromEntries(rows.map((row) => [row.id, roleFromDb(row.role)])),
          };
        }),
      getVaultDetail: (userId, vaultId) =>
        Effect.gen(function* () {
          const scope = yield* access.requireMember(userId, vaultId, "Not a member of this vault");
          const rows = yield* db
            .select()
            .from(vaults)
            .where(eq(vaults.id, vaultId))
            .limit(1)
            .pipe(Effect.orDie);
          const vault = rows[0];
          if (vault === undefined) {
            return yield* new Forbidden({ detail: "Not a member of this vault" });
          }
          const memberCounts = yield* db
            .select({ total: sql<number>`count(*)::int` })
            .from(vaultMemberships)
            .where(eq(vaultMemberships.vaultId, vaultId))
            .pipe(Effect.orDie);
          const articleCounts = yield* db
            .select({ total: sql<number>`count(*)::int` })
            .from(wikiArticles)
            .where(eq(wikiArticles.vaultId, vaultId))
            .pipe(Effect.orDie);
          return {
            ...vaultResponse(vault),
            role: scope.role,
            member_count: oneTotal(memberCounts),
            article_count: oneTotal(articleCounts),
          };
        }),
      getVaultConfig: (userId, vaultId) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          const content = yield* Effect.result(storage.readText(vaultId, CONFIG_PATH));
          if (content._tag === "Failure") {
            return defaultVaultConfig;
          }
          return yield* parseVaultConfig(content.success);
        }),
      listMembers: (userId, vaultId, params) =>
        Effect.gen(function* () {
          yield* access.requireOwner(userId, vaultId);
          const countRows = yield* db
            .select({ total: sql<number>`count(*)::int` })
            .from(vaultMemberships)
            .where(eq(vaultMemberships.vaultId, vaultId))
            .pipe(Effect.orDie);
          const rows = yield* db
            .select({
              userId: vaultMemberships.userId,
              role: vaultMemberships.role,
              email: users.email,
            })
            .from(vaultMemberships)
            .innerJoin(users, eq(users.id, vaultMemberships.userId))
            .where(eq(vaultMemberships.vaultId, vaultId))
            .orderBy(asc(users.email))
            .limit(params.limit)
            .offset(params.offset)
            .pipe(Effect.orDie);
          return pageEnvelope(
            rows.map((row) => ({
              user_id: asUuid(row.userId),
              email: asEmail(row.email),
              role: roleFromDb(row.role),
            })),
            params,
            oneTotal(countRows),
          );
        }),
    } satisfies VaultsServiceShape;
  }),
);
