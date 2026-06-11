import { Data, Effect } from "effect";
import { and, count, eq } from "drizzle-orm";
import type { BackendDb, DbSession } from "@great-minds/db/context";
import { sourceDocuments, users, vaultMemberships, vaults } from "@great-minds/db/schema";
import type { UserId } from "@great-minds/domain/user";
import {
  VaultMemberDetailsSchema,
  VaultSchema,
  VaultStatsSchema,
  type Vault,
  type VaultCreate,
  type VaultMemberDetails,
  type VaultPatch,
  type VaultStats,
} from "@great-minds/domain/vault";
import type { Workspace } from "@great-minds/domain/workspace";
import { firstOrDie, firstOrFail } from "./effect-helpers.js";
import { loadWorkspace, VaultUnavailable, type VaultScope } from "./workspace.js";

export class VaultForbidden extends Data.TaggedError("VaultForbidden")<{
  message: string;
}> {}

export function listVaults(db: BackendDb, userId: UserId): Effect.Effect<Vault[]> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ vault: vaults })
      .from(vaultMemberships)
      .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
      .where(eq(vaultMemberships.userId, userId))
      .orderBy(vaults.createdAt)
      .pipe(Effect.orDie);

    return VaultSchema.array().parse(rows.map((row) => row.vault));
  });
}

export function createVault(
  db: BackendDb,
  userId: UserId,
  input: VaultCreate,
): Effect.Effect<Workspace, VaultUnavailable> {
  return db
    .transaction((tx) =>
      Effect.gen(function* () {
        const vault = yield* createOwnedVault(tx, userId, input);
        return yield* loadWorkspace(tx, { userId, vaultId: vault.id });
      }),
    )
    .pipe(
      Effect.catchAll((error) => (error instanceof VaultUnavailable ? Effect.fail(error) : Effect.die(error))),
    );
}

export function updateVault(
  db: BackendDb,
  scope: VaultScope,
  patch: VaultPatch,
): Effect.Effect<Workspace, VaultForbidden | VaultUnavailable> {
  return db
    .transaction((tx) =>
      Effect.gen(function* () {
        yield* assertCanEditVault(tx, scope);

        const hasChanges = Object.keys(patch).length > 0;
        if (hasChanges) {
          yield* tx
            .update(vaults)
            .set(patch)
            .where(eq(vaults.id, scope.vaultId))
            .pipe(Effect.orDie);
        }

        return yield* loadWorkspace(tx, scope);
      }),
    )
    .pipe(
      Effect.catchAll((error) =>
        error instanceof VaultUnavailable || error instanceof VaultForbidden ? Effect.fail(error) : Effect.die(error),
      ),
    );
}

export function getVault(db: BackendDb, scope: VaultScope): Effect.Effect<Vault, VaultUnavailable> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ vault: vaults })
      .from(vaultMemberships)
      .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
      .where(and(eq(vaultMemberships.userId, scope.userId), eq(vaultMemberships.vaultId, scope.vaultId)))
      .limit(1)
      .pipe(Effect.orDie);

    const row = yield* firstOrFail(rows, () => new VaultUnavailable());
    return VaultSchema.parse(row.vault);
  });
}

export function listVaultMembers(
  db: BackendDb,
  scope: VaultScope,
): Effect.Effect<VaultMemberDetails[], VaultUnavailable> {
  return Effect.gen(function* () {
    yield* assertCanReadVault(db, scope);

    const rows = yield* db
      .select({
        user: users,
        role: vaultMemberships.role,
      })
      .from(vaultMemberships)
      .innerJoin(users, eq(users.id, vaultMemberships.userId))
      .where(eq(vaultMemberships.vaultId, scope.vaultId))
      .orderBy(vaultMemberships.createdAt)
      .pipe(Effect.orDie);

    return VaultMemberDetailsSchema.array().parse(rows);
  });
}

export function getVaultStats(db: BackendDb, scope: VaultScope): Effect.Effect<VaultStats, VaultUnavailable> {
  return Effect.gen(function* () {
    yield* assertCanReadVault(db, scope);

    const rows = yield* db
      .select({ total: count() })
      .from(sourceDocuments)
      .where(and(eq(sourceDocuments.vaultId, scope.vaultId), eq(sourceDocuments.sourceType, "wiki")))
      .pipe(Effect.orDie);

    const countRow = yield* firstOrDie(rows, "Failed to count vault articles");
    return VaultStatsSchema.parse({ articleCount: countRow.total });
  });
}

function createOwnedVault(
  db: DbSession,
  ownerId: UserId,
  input: VaultCreate,
): Effect.Effect<Vault> {
  return Effect.gen(function* () {
    const rows = yield* db
      .insert(vaults)
      .values({ ownerId, ...input })
      .returning()
      .pipe(Effect.orDie);
    const vault = yield* firstOrDie(rows, "Failed to create vault");

    yield* db
      .insert(vaultMemberships)
      .values({
        vaultId: vault.id,
        userId: ownerId,
        role: "owner",
      })
      .pipe(Effect.orDie);

    return VaultSchema.parse(vault);
  });
}

function assertCanReadVault(db: DbSession, scope: VaultScope): Effect.Effect<void, VaultUnavailable> {
  return Effect.gen(function* () {
    const role = yield* loadVaultRole(db, scope);
    if (!role) return yield* Effect.fail(new VaultUnavailable());
  });
}

function assertCanEditVault(
  db: DbSession,
  scope: VaultScope,
): Effect.Effect<void, VaultForbidden | VaultUnavailable> {
  return Effect.gen(function* () {
    const role = yield* loadVaultRole(db, scope);
    if (!role) return yield* Effect.fail(new VaultUnavailable());
    if (role === "viewer") return yield* Effect.fail(new VaultForbidden({ message: "Vault cannot be edited by this user" }));
  });
}

function loadVaultRole(db: DbSession, scope: VaultScope) {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ role: vaultMemberships.role })
      .from(vaultMemberships)
      .where(and(eq(vaultMemberships.userId, scope.userId), eq(vaultMemberships.vaultId, scope.vaultId)))
      .limit(1)
      .pipe(Effect.orDie);

    return rows[0]?.role;
  });
}
