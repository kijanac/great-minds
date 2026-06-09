import { and, count, eq } from "drizzle-orm";
import type { BackendDb, DbSession } from "../db/context.js";
import { sourceDocuments, users, vaultMemberships, vaults } from "../db/schema.js";
import type { UserId, VaultId } from "../domain/ids.js";
import {
  VaultSchema,
  VaultSettingsSchema,
  type Vault,
  type VaultCreate,
  type VaultPatch,
  type VaultSettings,
} from "../domain/vault.js";
import type { Workspace } from "../domain/workspace.js";
import { loadWorkspace, type Actor, type VaultScope } from "./workspace.js";

export async function listVaults(db: BackendDb, actor: Actor): Promise<Vault[]> {
  const rows = await db
    .select({ vault: vaults })
    .from(vaultMemberships)
    .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
    .where(eq(vaultMemberships.userId, actor.userId))
    .orderBy(vaults.createdAt);

  return rows.map((row) => VaultSchema.parse(row.vault));
}

export async function createVault(
  db: BackendDb,
  actor: Actor,
  input: VaultCreate,
): Promise<Workspace> {
  return db.transaction(async (tx) => {
    const vaultInput: { ownerId: UserId; name: string; thematicHint?: string; kinds?: string[] } = {
      ownerId: actor.userId,
      name: input.name,
    };
    if (input.thematicHint !== undefined) vaultInput.thematicHint = input.thematicHint;
    if (input.kinds !== undefined) vaultInput.kinds = input.kinds;

    const vault = await createOwnedVault(tx, vaultInput);
    return loadWorkspace(tx, { userId: actor.userId, vaultId: vault.id });
  });
}

export async function updateVault(
  db: BackendDb,
  scope: VaultScope,
  patch: VaultPatch,
): Promise<Workspace> {
  if (patch.vaultId !== scope.vaultId) throw new Error("Patch vaultId does not match request scope");

  return db.transaction(async (tx) => {
    await assertCanEditVault(tx, scope);

    const values: Partial<typeof vaults.$inferInsert> = {};
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.thematicHint !== undefined) values.thematicHint = patch.thematicHint;
    if (patch.kinds !== undefined) values.kinds = patch.kinds;

    if (Object.keys(values).length > 0) {
      await tx.update(vaults).set(values).where(eq(vaults.id, scope.vaultId));
    }

    return loadWorkspace(tx, scope);
  });
}

export async function getVaultSettings(
  db: BackendDb,
  scope: VaultScope,
): Promise<VaultSettings> {
  await assertCanReadVault(db, scope);

  const [vault] = await db.select().from(vaults).where(eq(vaults.id, scope.vaultId)).limit(1);
  if (!vault) throw new Error("Vault not found");

  const memberRows = await db
    .select({
      userId: users.id,
      email: users.email,
      role: vaultMemberships.role,
    })
    .from(vaultMemberships)
    .innerJoin(users, eq(users.id, vaultMemberships.userId))
    .where(eq(vaultMemberships.vaultId, scope.vaultId))
    .orderBy(vaultMemberships.createdAt);

  const [articleCount] = await db
    .select({ total: count() })
    .from(sourceDocuments)
    .where(and(eq(sourceDocuments.vaultId, scope.vaultId), eq(sourceDocuments.sourceType, "wiki")));

  return VaultSettingsSchema.parse({
    vault,
    members: memberRows,
    articleCount: articleCount?.total ?? 0,
  });
}

async function createOwnedVault(
  db: DbSession,
  input: { ownerId: UserId; name: string; thematicHint?: string; kinds?: string[] },
): Promise<Vault> {
  const values: typeof vaults.$inferInsert = {
    ownerId: input.ownerId,
    name: input.name,
  };
  if (input.thematicHint !== undefined) values.thematicHint = input.thematicHint;
  if (input.kinds !== undefined) values.kinds = input.kinds;

  const [vault] = await db.insert(vaults).values(values).returning();
  if (!vault) throw new Error("Failed to create vault");

  await db.insert(vaultMemberships).values({
    vaultId: vault.id,
    userId: input.ownerId,
    role: "owner",
  });

  return VaultSchema.parse(vault);
}

async function assertCanReadVault(db: DbSession, scope: VaultScope): Promise<void> {
  const [membership] = await db
    .select({ role: vaultMemberships.role })
    .from(vaultMemberships)
    .where(and(eq(vaultMemberships.userId, scope.userId), eq(vaultMemberships.vaultId, scope.vaultId)))
    .limit(1);

  if (!membership) throw new Error("Vault does not exist or is not available to this user");
}

async function assertCanEditVault(db: DbSession, scope: VaultScope): Promise<void> {
  const [membership] = await db
    .select({ role: vaultMemberships.role })
    .from(vaultMemberships)
    .where(and(eq(vaultMemberships.userId, scope.userId), eq(vaultMemberships.vaultId, scope.vaultId)))
    .limit(1);

  if (!membership || membership.role === "viewer") {
    throw new Error("Vault does not exist or cannot be edited by this user");
  }
}
