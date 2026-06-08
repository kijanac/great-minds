import { and, eq } from "drizzle-orm";
import type { LocalContext } from "../db/client";
import { appState, users, vaultMemberships, vaults } from "../db/schema";
import type { Transaction } from "../db/types";
import type { CreateVaultCommand, UpdateVaultCommand } from "../schema/vault";
import { VaultSchema } from "../schema/vault";
import {
  VaultMemberSchema,
  VaultSettingsSchema,
  type VaultSettings,
} from "../schema/vault-settings";
import type { Workspace } from "../schema/workspace";
import { APP_STATE_ID, loadCurrentWorkspace } from "./workspace";

export async function listVaults(ctx: LocalContext) {
  const rows = await ctx.db
    .select({ vault: vaults })
    .from(appState)
    .innerJoin(vaultMemberships, eq(vaultMemberships.userId, appState.userId))
    .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
    .where(eq(appState.id, APP_STATE_ID))
    .orderBy(vaults.createdAt);

  return rows.map((row) => VaultSchema.parse(row.vault));
}

export async function getVaultSettings(ctx: LocalContext, vaultId: string): Promise<VaultSettings> {
  const [vault] = await ctx.db.select().from(vaults).where(eq(vaults.id, vaultId)).limit(1);
  if (!vault) throw new Error("Vault not found");

  const memberRows = await ctx.db
    .select({
      userId: users.id,
      email: users.email,
      role: vaultMemberships.role,
    })
    .from(vaultMemberships)
    .innerJoin(users, eq(users.id, vaultMemberships.userId))
    .where(eq(vaultMemberships.vaultId, vaultId))
    .orderBy(vaultMemberships.createdAt);

  return VaultSettingsSchema.parse({
    vault,
    members: memberRows.map((member) => VaultMemberSchema.parse(member)),
    articleCount: 0,
  });
}

export async function createVault(
  ctx: LocalContext,
  command: CreateVaultCommand,
): Promise<Workspace> {
  return await ctx.db.transaction(async (tx) => {
    const [state] = await tx.select().from(appState).where(eq(appState.id, APP_STATE_ID)).limit(1);

    if (!state) throw new Error("Cannot create a vault before app state exists");

    const vault = await createOwnedVault(tx, {
      ownerId: state.userId,
      name: command.name,
      thematicHint: command.thematicHint,
      kinds: command.kinds,
    });

    await tx
      .update(appState)
      .set({ currentVaultId: vault.id, updatedAt: new Date() })
      .where(eq(appState.id, APP_STATE_ID));

    return loadCurrentWorkspace(tx);
  });
}

export async function updateVault(
  ctx: LocalContext,
  command: UpdateVaultCommand,
): Promise<Workspace> {
  return await ctx.db.transaction(async (tx) => {
    const values: Partial<typeof vaults.$inferInsert> = {};
    if (command.name !== undefined) values.name = command.name;
    if (command.thematicHint !== undefined) values.thematicHint = command.thematicHint;
    if (command.kinds !== undefined) values.kinds = command.kinds;

    if (Object.keys(values).length > 0) {
      await tx.update(vaults).set(values).where(eq(vaults.id, command.vaultId));
    }

    return loadCurrentWorkspace(tx);
  });
}

export async function switchVault(ctx: LocalContext, vaultId: string): Promise<Workspace> {
  return await ctx.db.transaction(async (tx) => {
    const [state] = await tx.select().from(appState).where(eq(appState.id, APP_STATE_ID)).limit(1);

    if (!state) throw new Error("Cannot switch vault before app state exists");

    const [target] = await tx
      .select({ id: vaults.id })
      .from(vaultMemberships)
      .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
      .where(and(eq(vaultMemberships.userId, state.userId), eq(vaults.id, vaultId)))
      .limit(1);

    if (!target) throw new Error("Vault does not exist or is not available to this user");

    await tx
      .update(appState)
      .set({ currentVaultId: vaultId, updatedAt: new Date() })
      .where(eq(appState.id, APP_STATE_ID));

    return loadCurrentWorkspace(tx);
  });
}

export async function createOwnedVault(
  tx: Transaction,
  input: { ownerId: string; name: string; thematicHint?: string; kinds?: string[] },
) {
  const values: typeof vaults.$inferInsert = {
    ownerId: input.ownerId,
    name: input.name,
  };

  if (input.thematicHint !== undefined) values.thematicHint = input.thematicHint;
  if (input.kinds !== undefined) values.kinds = input.kinds;

  const [vault] = await tx.insert(vaults).values(values).returning();

  if (!vault) throw new Error("Failed to create vault");

  await tx.insert(vaultMemberships).values({
    vaultId: vault.id,
    userId: input.ownerId,
    role: "owner",
  });

  return vault;
}
