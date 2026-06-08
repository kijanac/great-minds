import { eq } from "drizzle-orm";
import type { LocalContext } from "../db/client";
import { appState, users } from "../db/schema";
import type { Transaction } from "../db/types";
import type { User } from "../schema/user";
import type { Workspace } from "../schema/workspace";
import { createOwnedVault } from "./vaults";
import { APP_STATE_ID, loadCurrentWorkspace } from "./workspace";
const LOCAL_USER_EMAIL = "local@great-minds.local";
const DEFAULT_VAULT_NAME = "My Library";

export async function ensureWorkspace(ctx: LocalContext): Promise<Workspace> {
  return await ctx.db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: appState.id })
      .from(appState)
      .where(eq(appState.id, APP_STATE_ID))
      .limit(1);

    if (existing) {
      return loadCurrentWorkspace(tx);
    }

    const user = await getOrCreateLocalUser(tx);
    const vault = await createOwnedVault(tx, {
      ownerId: user.id,
      name: DEFAULT_VAULT_NAME,
    });

    await tx.insert(appState).values({
      id: APP_STATE_ID,
      userId: user.id,
      currentVaultId: vault.id,
    });

    return loadCurrentWorkspace(tx);
  });
}

async function getOrCreateLocalUser(tx: Transaction): Promise<User> {
  const [createdUser] = await tx
    .insert(users)
    .values({ email: LOCAL_USER_EMAIL })
    .onConflictDoNothing({ target: users.email })
    .returning();

  if (createdUser) return createdUser;

  const [existingUser] = await tx
    .select()
    .from(users)
    .where(eq(users.email, LOCAL_USER_EMAIL))
    .limit(1);

  if (!existingUser) throw new Error("Failed to ensure local user");

  return existingUser;
}
