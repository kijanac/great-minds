import { randomUUID } from "node:crypto";

import { Database, vaultMemberships, vaults } from "@great-minds/database";
import { eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import type { Email, Uuid } from "@great-minds/domain";

type CountRow = {
  readonly count: number;
};

export type VaultsServiceShape = {
  readonly ensureDefaultForUser: (userId: Uuid, email: Email) => Effect.Effect<void>;
  readonly deleteOwnedVaults: (userId: Uuid) => Effect.Effect<void>;
};

export class VaultsService extends Context.Service<VaultsService, VaultsServiceShape>()(
  "@great-minds/server/VaultsService"
) {}

const oneCount = (rows: readonly CountRow[]) => {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("count query returned no rows");
  }
  return row.count;
};

export const VaultsServiceLive = Layer.effect(
  VaultsService,
  Effect.gen(function* () {
    const db = yield* Database;
    return {
      ensureDefaultForUser: (userId, email) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            const membershipCounts = yield* tx
              .select({ count: sql<number>`count(*)::int` })
              .from(vaultMemberships)
              .where(eq(vaultMemberships.userId, userId));
            if (oneCount(membershipCounts) > 0) {
              return;
            }

            const vaultId = randomUUID();
            yield* tx.insert(vaults).values({
              id: vaultId,
              name: `${email}'s vault`,
              ownerId: userId
            });
            yield* tx.insert(vaultMemberships).values({
              id: randomUUID(),
              vaultId,
              userId,
              role: "OWNER"
            });
          })
        ).pipe(Effect.orDie),
      deleteOwnedVaults: (userId) =>
        db.delete(vaults).where(eq(vaults.ownerId, userId)).pipe(Effect.orDie)
    } satisfies VaultsServiceShape;
  })
);
