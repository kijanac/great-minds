import { eq } from "drizzle-orm";
import { appState, users, vaults } from "../db/schema";
import type { Transaction } from "../db/types";
import { WorkspaceSchema, type Workspace } from "../schema/workspace";

export const APP_STATE_ID = "default";

export async function loadCurrentWorkspace(tx: Transaction): Promise<Workspace> {
  const [workspace] = await tx
    .select({ appState, user: users, vault: vaults })
    .from(appState)
    .innerJoin(users, eq(users.id, appState.userId))
    .innerJoin(vaults, eq(vaults.id, appState.currentVaultId))
    .where(eq(appState.id, APP_STATE_ID))
    .limit(1);

  if (!workspace) {
    throw new Error("Current workspace could not be materialized from app state");
  }

  return WorkspaceSchema.parse(workspace);
}
