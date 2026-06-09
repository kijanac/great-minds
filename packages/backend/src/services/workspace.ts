import { and, eq } from "drizzle-orm";
import type { BackendDb, BackendTx, DbSession } from "../db/context.js";
import { users, vaultMemberships, vaults } from "../db/schema.js";
import type { UserId, VaultId } from "../domain/ids.js";
import { WorkspaceSchema, type Workspace } from "../domain/workspace.js";

export type Actor = {
  userId: UserId;
};

export type VaultScope = Actor & {
  vaultId: VaultId;
};

export async function loadWorkspace(db: DbSession, scope: VaultScope): Promise<Workspace> {
  const [workspace] = await db
    .select({ user: users, vault: vaults })
    .from(vaultMemberships)
    .innerJoin(users, eq(users.id, vaultMemberships.userId))
    .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
    .where(and(eq(vaultMemberships.userId, scope.userId), eq(vaultMemberships.vaultId, scope.vaultId)))
    .limit(1);

  if (!workspace) throw new Error("Vault does not exist or is not available to this user");

  return WorkspaceSchema.parse(workspace);
}

export function transaction<T>(db: BackendDb, run: (tx: BackendTx) => Promise<T>): Promise<T> {
  return db.transaction(run);
}
