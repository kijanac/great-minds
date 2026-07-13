import { Database, llmCostEvents } from "@great-minds/database";
import { Forbidden, type CostAggregate, type CostQuery, type Uuid } from "@great-minds/domain";
import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { dieDatabase } from "./db-defects.ts";
import { VaultAccessService } from "./vaults.ts";

type CostsServiceShape = {
  readonly forUser: (userId: Uuid, query: CostQuery) => Effect.Effect<CostAggregate>;
  readonly forVault: (
    userId: Uuid,
    vaultId: Uuid,
    query: CostQuery,
  ) => Effect.Effect<CostAggregate, Forbidden>;
};

export class CostsService extends Context.Service<CostsService, CostsServiceShape>()(
  "@great-minds/server/CostsService",
) {}

export const CostsServiceLive = Layer.effect(
  CostsService,
  Effect.gen(function* () {
    const db = yield* Database;
    const access = yield* VaultAccessService;

    const aggregate = (scope: SQL, query: CostQuery) =>
      Effect.gen(function* () {
        const conditions: SQL[] = [scope];
        if (query.since !== undefined) conditions.push(gte(llmCostEvents.createdAt, query.since));
        if (query.until !== undefined) conditions.push(lte(llmCostEvents.createdAt, query.until));
        const where = and(...conditions);
        const totals = yield* db
          .select({
            totalUsd: sql<string>`coalesce(sum(${llmCostEvents.costUsd}), 0)::numeric(12, 6)`,
            eventCount: sql<number>`count(${llmCostEvents.id})::int`,
          })
          .from(llmCostEvents)
          .where(where)
          .pipe(dieDatabase);
        const byVault = yield* db
          .select({
            key: sql<string>`coalesce(${llmCostEvents.vaultId}::text, '(no-vault)')`,
            totalUsd: sql<string>`coalesce(sum(${llmCostEvents.costUsd}), 0)::numeric(12, 6)`,
            eventCount: sql<number>`count(${llmCostEvents.id})::int`,
          })
          .from(llmCostEvents)
          .where(where)
          .groupBy(llmCostEvents.vaultId)
          .orderBy(desc(sql`sum(${llmCostEvents.costUsd})`))
          .pipe(dieDatabase);
        const byEventType = yield* db
          .select({
            key: llmCostEvents.eventType,
            totalUsd: sql<string>`coalesce(sum(${llmCostEvents.costUsd}), 0)::numeric(12, 6)`,
            eventCount: sql<number>`count(${llmCostEvents.id})::int`,
          })
          .from(llmCostEvents)
          .where(where)
          .groupBy(llmCostEvents.eventType)
          .orderBy(desc(sql`sum(${llmCostEvents.costUsd})`))
          .pipe(dieDatabase);
        const total = totals[0];
        if (total === undefined) throw new Error("cost aggregate returned no total row");
        return {
          total_usd: total.totalUsd,
          event_count: total.eventCount,
          by_vault: byVault.map((row) => ({
            key: row.key,
            total_usd: row.totalUsd,
            event_count: row.eventCount,
          })),
          by_event_type: byEventType.map((row) => ({
            key: row.key,
            total_usd: row.totalUsd,
            event_count: row.eventCount,
          })),
        } satisfies CostAggregate;
      });

    return {
      forUser: (userId, query) => aggregate(eq(llmCostEvents.userId, userId), query),
      forVault: (userId, vaultId, query) =>
        Effect.gen(function* () {
          yield* access.requireMember(userId, vaultId);
          return yield* aggregate(eq(llmCostEvents.vaultId, vaultId), query);
        }),
    } satisfies CostsServiceShape;
  }),
);
