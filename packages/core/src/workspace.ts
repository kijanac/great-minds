import { Data, Effect } from "effect";
import { and, eq } from "drizzle-orm";
import type { DbSession } from "@great-minds/db/context";
import { users, vaultMemberships, vaults } from "@great-minds/db/schema";
import type { UserId } from "@great-minds/domain/user";
import type { VaultId } from "@great-minds/domain/vault";
import { WorkspaceSchema, type Workspace } from "@great-minds/domain/workspace";
import { firstOrFail, parseOrFail } from "./effect-helpers.js";

export type VaultScope = {
  userId: UserId;
  vaultId: VaultId;
};

export class VaultUnavailable extends Data.TaggedError("VaultUnavailable") {}

export function loadWorkspace(db: DbSession, scope: VaultScope): Effect.Effect<Workspace, VaultUnavailable> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ user: users, vault: vaults })
      .from(vaultMemberships)
      .innerJoin(users, eq(users.id, vaultMemberships.userId))
      .innerJoin(vaults, eq(vaults.id, vaultMemberships.vaultId))
      .where(and(eq(vaultMemberships.userId, scope.userId), eq(vaultMemberships.vaultId, scope.vaultId)))
      .limit(1)
      .pipe(Effect.mapError(() => new VaultUnavailable()));

    const workspace = yield* firstOrFail(rows, () => new VaultUnavailable());
    return yield* parseOrFail(() => WorkspaceSchema.parse(workspace), () => new VaultUnavailable());
  });
}

