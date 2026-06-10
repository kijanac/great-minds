import { Data } from "effect";
import { and, eq } from "drizzle-orm";
import type { DbSession } from "@great-minds/db/context";
import { users, vaultMemberships, vaults } from "@great-minds/db/schema";
import type { UserId } from "@great-minds/domain/user";
import type { VaultId } from "@great-minds/domain/vault";
import { WorkspaceSchema, type Workspace } from "@great-minds/domain/workspace";

export type VaultScope = {
  userId: UserId;
  vaultId: VaultId;
};

export class VaultUnavailable extends Data.TaggedError("VaultUnavailable") {}

export async function loadWorkspace(db: DbSession, scope: VaultScope): Promise<Workspace> {
  const [workspace] = await db
    .select({ user: users, vault: vaults })
    .from(vaultMemberships)
    .innerJoin(users, eq(users.id, vaultMemberships.userId))
    .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
    .where(and(eq(vaultMemberships.userId, scope.userId), eq(vaultMemberships.vaultId, scope.vaultId)))
    .limit(1);

  if (!workspace) throw new VaultUnavailable();

  return WorkspaceSchema.parse(workspace);
}

