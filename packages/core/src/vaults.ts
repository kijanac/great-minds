import { Context, Data, Effect, Layer } from "effect";
import { and, count, eq } from "drizzle-orm";
import { Db, type DbSession } from "@great-minds/db/context";
import { sourceDocuments, users, vaultMemberships, vaults } from "@great-minds/db/schema";
import type { UserId } from "@great-minds/domain/user";
import {
  VaultInternalSchema,
  VaultMemberDetailsSchema,
  VaultSchema,
  VaultStatsSchema,
  type Vault,
  type VaultCreate,
  type VaultCreateCommand,
  type VaultInternal,
  type VaultMemberDetails,
  type VaultMemberInvite,
  type VaultMemberUpdate,
  type VaultPatch,
  type VaultStats,
} from "@great-minds/domain/vault";
import type { Workspace } from "@great-minds/domain/workspace";
import { firstOrDie, firstOrFail } from "./effect-helpers.js";
import { StorageOperationFailed, VaultStorage } from "./storage.js";
import { getUserByIdWith, ensureUserWith, UserUnavailable } from "./users.js";
import { loadWorkspaceWith, VaultUnavailable, type VaultScope } from "./workspace.js";

export class VaultForbidden extends Data.TaggedError("VaultForbidden")<{
  message: string;
}> {}

export class VaultMemberUnavailable extends Data.TaggedError("VaultMemberUnavailable")<{
  message: string;
}> {}

export class VaultMemberAlreadyExists extends Data.TaggedError("VaultMemberAlreadyExists")<{
  message: string;
}> {}

export class VaultService extends Context.Service<
  VaultService,
  {
    readonly listVaults: (userId: UserId) => Effect.Effect<Vault[]>;
    readonly createVault: (
      userId: UserId,
      input: VaultCreateCommand,
    ) => Effect.Effect<Workspace, StorageOperationFailed>;
    readonly getVault: (scope: VaultScope) => Effect.Effect<Vault, VaultUnavailable>;
    readonly updateVault: (
      scope: VaultScope,
      patch: VaultPatch,
    ) => Effect.Effect<Workspace, VaultForbidden | VaultUnavailable>;
    readonly deleteVault: (
      scope: VaultScope,
    ) => Effect.Effect<void, VaultForbidden | StorageOperationFailed | VaultUnavailable>;
    readonly listMembers: (
      scope: VaultScope,
    ) => Effect.Effect<VaultMemberDetails[], VaultForbidden | VaultUnavailable>;
    readonly inviteMember: (
      scope: VaultScope,
      input: VaultMemberInvite,
    ) => Effect.Effect<
      VaultMemberDetails,
      VaultForbidden | VaultMemberAlreadyExists | VaultUnavailable
    >;
    readonly updateMember: (
      scope: VaultScope,
      memberUserId: UserId,
      input: VaultMemberUpdate,
    ) => Effect.Effect<
      VaultMemberDetails,
      UserUnavailable | VaultForbidden | VaultMemberUnavailable | VaultUnavailable
    >;
    readonly removeMember: (
      scope: VaultScope,
      memberUserId: UserId,
    ) => Effect.Effect<void, VaultForbidden | VaultMemberUnavailable | VaultUnavailable>;
    readonly getStats: (scope: VaultScope) => Effect.Effect<VaultStats, VaultUnavailable>;
  }
>()("VaultService") {}

export const vaultServiceLayer = Layer.effect(
  VaultService,
  Effect.gen(function* () {
    const db = yield* Db;
    const storage = yield* VaultStorage;

    return VaultService.of({
      listVaults: (userId) => listVaults(userId).pipe(Effect.provideService(Db, db)),
      createVault: (userId, input) =>
        createVault(userId, input).pipe(
          Effect.provideService(Db, db),
          Effect.provideService(VaultStorage, storage),
        ),
      getVault: (scope) => getVault(scope).pipe(Effect.provideService(Db, db)),
      updateVault: (scope, patch) => updateVault(scope, patch).pipe(Effect.provideService(Db, db)),
      deleteVault: (scope) =>
        deleteVault(scope).pipe(
          Effect.provideService(Db, db),
          Effect.provideService(VaultStorage, storage),
        ),
      listMembers: (scope) => listVaultMembers(scope).pipe(Effect.provideService(Db, db)),
      inviteMember: (scope, input) =>
        inviteVaultMember(scope, input).pipe(Effect.provideService(Db, db)),
      updateMember: (scope, memberUserId, input) =>
        updateVaultMember(scope, memberUserId, input).pipe(Effect.provideService(Db, db)),
      removeMember: (scope, memberUserId) =>
        removeVaultMember(scope, memberUserId).pipe(Effect.provideService(Db, db)),
      getStats: (scope) => getVaultStats(scope).pipe(Effect.provideService(Db, db)),
    });
  }),
);

function listVaults(userId: UserId): Effect.Effect<Vault[], never, Db> {
  return Effect.gen(function* () {
    const db = yield* Db;
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

function createVault(
  userId: UserId,
  input: VaultCreateCommand,
): Effect.Effect<Workspace, StorageOperationFailed, Db | VaultStorage> {
  return Effect.gen(function* () {
    const db = yield* Db;
    const storage = yield* VaultStorage;
    const storageBucketName = yield* storage.prepareBucketForOwner(userId);
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const vault = yield* createOwnedVault(tx, userId, { ...input, storageBucketName });
          return yield* loadWorkspaceWith(tx, { userId, vaultId: vault.id }).pipe(Effect.orDie);
        }),
      )
      .pipe(Effect.orDie);
  });
}

function updateVault(
  scope: VaultScope,
  patch: VaultPatch,
): Effect.Effect<Workspace, VaultForbidden | VaultUnavailable, Db> {
  return Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
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

          return yield* loadWorkspaceWith(tx, scope);
        }),
      )
      .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
  });
}

function deleteVault(
  scope: VaultScope,
): Effect.Effect<
  void,
  VaultForbidden | StorageOperationFailed | VaultUnavailable,
  Db | VaultStorage
> {
  return Effect.gen(function* () {
    const db = yield* Db;
    const storage = yield* VaultStorage;
    const vault = yield* getVaultInternal(scope);

    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* assertOwnVault(tx, scope);
          const rows = yield* tx
            .delete(vaults)
            .where(eq(vaults.id, scope.vaultId))
            .returning({ id: vaults.id })
            .pipe(Effect.orDie);

          yield* firstOrFail(rows, () => new VaultUnavailable());
        }),
      )
      .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));

    yield* storage.clearVault(vault);
  });
}

function getVault(scope: VaultScope): Effect.Effect<Vault, VaultUnavailable, Db> {
  return getVaultInternal(scope).pipe(Effect.map((vault) => VaultSchema.parse(vault)));
}

function getVaultInternal(scope: VaultScope): Effect.Effect<VaultInternal, VaultUnavailable, Db> {
  return Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select({ vault: vaults })
      .from(vaultMemberships)
      .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
      .where(
        and(eq(vaultMemberships.userId, scope.userId), eq(vaultMemberships.vaultId, scope.vaultId)),
      )
      .limit(1)
      .pipe(Effect.orDie);

    const row = yield* firstOrFail(rows, () => new VaultUnavailable());
    return VaultInternalSchema.parse(row.vault);
  });
}

function listVaultMembers(
  scope: VaultScope,
): Effect.Effect<VaultMemberDetails[], VaultForbidden | VaultUnavailable, Db> {
  return Effect.gen(function* () {
    const db = yield* Db;
    yield* assertOwnVault(db, scope);

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

function inviteVaultMember(
  scope: VaultScope,
  input: VaultMemberInvite,
): Effect.Effect<
  VaultMemberDetails,
  VaultForbidden | VaultMemberAlreadyExists | VaultUnavailable,
  Db
> {
  return Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* assertOwnVault(tx, scope);
          const user = yield* ensureUserWith(tx, { email: input.email });
          const rows = yield* tx
            .insert(vaultMemberships)
            .values({ vaultId: scope.vaultId, userId: user.id, role: input.role })
            .onConflictDoNothing({
              target: [vaultMemberships.vaultId, vaultMemberships.userId],
            })
            .returning({ role: vaultMemberships.role })
            .pipe(Effect.orDie);

          const membership = yield* firstOrFail(
            rows,
            () =>
              new VaultMemberAlreadyExists({ message: "User is already a member of this vault" }),
          );
          return VaultMemberDetailsSchema.parse({ user, role: membership.role });
        }),
      )
      .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
  });
}

function updateVaultMember(
  scope: VaultScope,
  memberUserId: UserId,
  input: VaultMemberUpdate,
): Effect.Effect<
  VaultMemberDetails,
  UserUnavailable | VaultForbidden | VaultMemberUnavailable | VaultUnavailable,
  Db
> {
  return Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* assertOwnVault(tx, scope);
          const user = yield* getUserByIdWith(tx, memberUserId);
          const rows = yield* tx
            .update(vaultMemberships)
            .set({ role: input.role })
            .where(
              and(
                eq(vaultMemberships.vaultId, scope.vaultId),
                eq(vaultMemberships.userId, memberUserId),
              ),
            )
            .returning({ role: vaultMemberships.role })
            .pipe(Effect.orDie);

          const membership = yield* firstOrFail(
            rows,
            () => new VaultMemberUnavailable({ message: "Membership not found" }),
          );
          return VaultMemberDetailsSchema.parse({ user, role: membership.role });
        }),
      )
      .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
  });
}

function removeVaultMember(
  scope: VaultScope,
  memberUserId: UserId,
): Effect.Effect<void, VaultForbidden | VaultMemberUnavailable | VaultUnavailable, Db> {
  return Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* assertOwnVault(tx, scope);
          const rows = yield* tx
            .delete(vaultMemberships)
            .where(
              and(
                eq(vaultMemberships.vaultId, scope.vaultId),
                eq(vaultMemberships.userId, memberUserId),
              ),
            )
            .returning({ id: vaultMemberships.id })
            .pipe(Effect.orDie);

          yield* firstOrFail(
            rows,
            () => new VaultMemberUnavailable({ message: "Membership not found" }),
          );
        }),
      )
      .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
  });
}

function getVaultStats(scope: VaultScope): Effect.Effect<VaultStats, VaultUnavailable, Db> {
  return Effect.gen(function* () {
    const db = yield* Db;
    yield* assertCanReadVault(db, scope);

    const rows = yield* db
      .select({ total: count() })
      .from(sourceDocuments)
      .where(
        and(eq(sourceDocuments.vaultId, scope.vaultId), eq(sourceDocuments.sourceType, "wiki")),
      )
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

function assertCanReadVault(
  db: DbSession,
  scope: VaultScope,
): Effect.Effect<void, VaultUnavailable> {
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
    if (role === "viewer")
      return yield* Effect.fail(
        new VaultForbidden({ message: "Vault cannot be edited by this user" }),
      );
  });
}

function assertOwnVault(
  db: DbSession,
  scope: VaultScope,
): Effect.Effect<void, VaultForbidden | VaultUnavailable> {
  return Effect.gen(function* () {
    const role = yield* loadVaultRole(db, scope);
    if (!role) return yield* Effect.fail(new VaultUnavailable());
    if (role !== "owner")
      return yield* Effect.fail(new VaultForbidden({ message: "Vault owner permission required" }));
  });
}

function loadVaultRole(db: DbSession, scope: VaultScope) {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ role: vaultMemberships.role })
      .from(vaultMemberships)
      .where(
        and(eq(vaultMemberships.userId, scope.userId), eq(vaultMemberships.vaultId, scope.vaultId)),
      )
      .limit(1)
      .pipe(Effect.orDie);

    return rows[0]?.role;
  });
}
