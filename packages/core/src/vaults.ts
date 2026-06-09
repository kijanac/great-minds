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
import { loadWorkspace, type VaultScope } from "./workspace.js";

export async function listVaults(db: BackendDb, userId: UserId): Promise<Vault[]> {
  const rows = await db
    .select({ vault: vaults })
    .from(vaultMemberships)
    .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
    .where(eq(vaultMemberships.userId, userId))
    .orderBy(vaults.createdAt);

  return VaultSchema.array().parse(rows.map((row) => row.vault));
}

export async function createVault(
  db: BackendDb,
  userId: UserId,
  input: VaultCreate,
): Promise<Workspace> {
  return db.transaction(async (tx) => {
    const vault = await createOwnedVault(tx, userId, input);
    return loadWorkspace(tx, { userId, vaultId: vault.id });
  });
}

export async function updateVault(
  db: BackendDb,
  scope: VaultScope,
  patch: VaultPatch,
): Promise<Workspace> {
  return db.transaction(async (tx) => {
    await assertCanEditVault(tx, scope);

    const hasChanges = Object.keys(patch).length > 0;
    if (hasChanges) {
      await tx.update(vaults).set(patch).where(eq(vaults.id, scope.vaultId));
    }

    return loadWorkspace(tx, scope);
  });
}

export async function getVault(db: BackendDb, scope: VaultScope): Promise<Vault> {
  const [row] = await db
    .select({ vault: vaults })
    .from(vaultMemberships)
    .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
    .where(and(eq(vaultMemberships.userId, scope.userId), eq(vaultMemberships.vaultId, scope.vaultId)))
    .limit(1);

  if (!row) throw new Error("Vault does not exist or is not available to this user");
  return VaultSchema.parse(row.vault);
}

export async function listVaultMembers(
  db: BackendDb,
  scope: VaultScope,
): Promise<VaultMemberDetails[]> {
  await assertCanReadVault(db, scope);

  const rows = await db
    .select({
      user: users,
      role: vaultMemberships.role,
    })
    .from(vaultMemberships)
    .innerJoin(users, eq(users.id, vaultMemberships.userId))
    .where(eq(vaultMemberships.vaultId, scope.vaultId))
    .orderBy(vaultMemberships.createdAt);

  return VaultMemberDetailsSchema.array().parse(rows);
}

export async function getVaultStats(db: BackendDb, scope: VaultScope): Promise<VaultStats> {
  await assertCanReadVault(db, scope);

  const [countRow] = await db
    .select({ total: count() })
    .from(sourceDocuments)
    .where(and(eq(sourceDocuments.vaultId, scope.vaultId), eq(sourceDocuments.sourceType, "wiki")));

  if (!countRow) throw new Error("Failed to count vault articles");
  return VaultStatsSchema.parse({ articleCount: countRow.total });
}

async function createOwnedVault(
  db: DbSession,
  ownerId: UserId,
  input: VaultCreate,
): Promise<Vault> {
  const [vault] = await db.insert(vaults).values({ ownerId, ...input }).returning();
  if (!vault) throw new Error("Failed to create vault");

  await db.insert(vaultMemberships).values({
    vaultId: vault.id,
    userId: ownerId,
    role: "owner",
  });

  return VaultSchema.parse(vault);
}

async function assertCanReadVault(db: DbSession, scope: VaultScope): Promise<void> {
  const role = await loadVaultRole(db, scope);
  if (!role) throw new Error("Vault does not exist or is not available to this user");
}

async function assertCanEditVault(db: DbSession, scope: VaultScope): Promise<void> {
  const role = await loadVaultRole(db, scope);
  if (!role || role === "viewer") {
    throw new Error("Vault does not exist or cannot be edited by this user");
  }
}

async function loadVaultRole(db: DbSession, scope: VaultScope) {
  const [membership] = await db
    .select({ role: vaultMemberships.role })
    .from(vaultMemberships)
    .where(and(eq(vaultMemberships.userId, scope.userId), eq(vaultMemberships.vaultId, scope.vaultId)))
    .limit(1);

  return membership?.role;
}
