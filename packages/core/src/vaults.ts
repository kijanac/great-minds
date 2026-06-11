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
import { firstOrFail, parseOrFail } from "./effect-helpers.js";
import { loadWorkspace, VaultUnavailable, type VaultScope } from "./workspace.js";

export class VaultForbidden extends Data.TaggedError("VaultForbidden")<{
  message: string;
}> {}

export class VaultPersistenceFailed extends Data.TaggedError("VaultPersistenceFailed")<{
  message: string;
}> {}

export function listVaults(db: BackendDb, userId: UserId): Effect.Effect<Vault[], VaultPersistenceFailed> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ vault: vaults })
      .from(vaultMemberships)
      .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
      .where(eq(vaultMemberships.userId, userId))
      .orderBy(vaults.createdAt)
      .pipe(Effect.mapError(() => new VaultPersistenceFailed({ message: "Failed to list vaults" })));

    return yield* parseOrFail(
      () => VaultSchema.array().parse(rows.map((row) => row.vault)),
      () => new VaultPersistenceFailed({ message: "Failed to list vaults" }),
    );
  });
}

export function createVault(
  db: BackendDb,
  userId: UserId,
  input: VaultCreate,
): Effect.Effect<Workspace, VaultPersistenceFailed | VaultUnavailable> {
  return db
    .transaction((tx) =>
      Effect.gen(function* () {
        const vault = yield* createOwnedVault(tx, userId, input);
        return yield* loadWorkspace(tx, { userId, vaultId: vault.id });
      }),
    )
    .pipe(
      Effect.mapError((error) =>
        error instanceof VaultUnavailable || error instanceof VaultPersistenceFailed
          ? error
          : new VaultPersistenceFailed({ message: "Failed to create vault" }),
      ),
    );
}

export function updateVault(
  db: BackendDb,
  scope: VaultScope,
  patch: VaultPatch,
): Effect.Effect<Workspace, VaultForbidden | VaultPersistenceFailed | VaultUnavailable> {
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
            .pipe(Effect.mapError(() => new VaultPersistenceFailed({ message: "Failed to update vault" })));
        }

        return yield* loadWorkspace(tx, scope);
      }),
    )
    .pipe(
      Effect.mapError((error) =>
        error instanceof VaultUnavailable || error instanceof VaultForbidden || error instanceof VaultPersistenceFailed
          ? error
          : new VaultPersistenceFailed({ message: "Failed to update vault" }),
      ),
    );
}

export function getVault(db: BackendDb, scope: VaultScope): Effect.Effect<Vault, VaultPersistenceFailed | VaultUnavailable> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ vault: vaults })
      .from(vaultMemberships)
      .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
      .where(and(eq(vaultMemberships.userId, scope.userId), eq(vaultMemberships.vaultId, scope.vaultId)))
      .limit(1)
      .pipe(Effect.mapError(() => new VaultPersistenceFailed({ message: "Failed to load vault" })));

    const row = yield* firstOrFail(rows, () => new VaultUnavailable());
    return yield* parseOrFail(() => VaultSchema.parse(row.vault), () => new VaultPersistenceFailed({ message: "Failed to load vault" }));
  });
}

export function listVaultMembers(
  db: BackendDb,
  scope: VaultScope,
): Effect.Effect<VaultMemberDetails[], VaultPersistenceFailed | VaultUnavailable> {
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
      .pipe(Effect.mapError(() => new VaultPersistenceFailed({ message: "Failed to list vault members" })));

    return yield* parseOrFail(
      () => VaultMemberDetailsSchema.array().parse(rows),
      () => new VaultPersistenceFailed({ message: "Failed to list vault members" }),
    );
  });
}

export function getVaultStats(db: BackendDb, scope: VaultScope): Effect.Effect<VaultStats, VaultPersistenceFailed | VaultUnavailable> {
  return Effect.gen(function* () {
    yield* assertCanReadVault(db, scope);

    const rows = yield* db
      .select({ total: count() })
      .from(sourceDocuments)
      .where(and(eq(sourceDocuments.vaultId, scope.vaultId), eq(sourceDocuments.sourceType, "wiki")))
      .pipe(Effect.mapError(() => new VaultPersistenceFailed({ message: "Failed to count vault articles" })));

    const countRow = yield* firstOrFail(rows, () => new VaultPersistenceFailed({ message: "Failed to count vault articles" }));
    return yield* parseOrFail(
      () => VaultStatsSchema.parse({ articleCount: countRow.total }),
      () => new VaultPersistenceFailed({ message: "Failed to count vault articles" }),
    );
  });
}

function createOwnedVault(
  db: DbSession,
  ownerId: UserId,
  input: VaultCreate,
): Effect.Effect<Vault, VaultPersistenceFailed> {
  return Effect.gen(function* () {
    const rows = yield* db
      .insert(vaults)
      .values({ ownerId, ...input })
      .returning()
      .pipe(Effect.mapError(() => new VaultPersistenceFailed({ message: "Failed to create vault" })));
    const vault = yield* firstOrFail(rows, () => new VaultPersistenceFailed({ message: "Failed to create vault" }));

    yield* db
      .insert(vaultMemberships)
      .values({
        vaultId: vault.id,
        userId: ownerId,
        role: "owner",
      })
      .pipe(Effect.mapError(() => new VaultPersistenceFailed({ message: "Failed to create vault" })));

    return yield* parseOrFail(() => VaultSchema.parse(vault), () => new VaultPersistenceFailed({ message: "Failed to create vault" }));
  });
}

function assertCanReadVault(db: DbSession, scope: VaultScope): Effect.Effect<void, VaultPersistenceFailed | VaultUnavailable> {
  return Effect.gen(function* () {
    const role = yield* loadVaultRole(db, scope);
    if (!role) return yield* Effect.fail(new VaultUnavailable());
  });
}

function assertCanEditVault(
  db: DbSession,
  scope: VaultScope,
): Effect.Effect<void, VaultForbidden | VaultPersistenceFailed | VaultUnavailable> {
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
      .pipe(Effect.mapError(() => new VaultPersistenceFailed({ message: "Failed to load vault membership" })));

    return rows[0]?.role;
  });
}
