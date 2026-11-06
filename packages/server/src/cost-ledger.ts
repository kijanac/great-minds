import { Database, llmCostEvents, vaults } from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

export type CostScope = {
  readonly vaultId: Uuid;
  readonly runId?: Uuid;
  readonly userId?: Uuid;
  readonly eventType: "compile" | "query.embed";
  readonly phase: string;
  readonly correlationId?: string;
};

export type CostEntry = CostScope & {
  readonly model: string;
  readonly promptTokens: number | undefined;
  readonly costUsd: number;
};

type CostLedgerShape = {
  readonly record: (entry: CostEntry) => Effect.Effect<void>;
};

export class CostLedger extends Context.Service<CostLedger, CostLedgerShape>()(
  "@great-minds/server/CostLedger",
) {}

export const CostLedgerLive = Layer.effect(
  CostLedger,
  Effect.map(Database, (db) => ({
    record: (entry) =>
      db.query((d) =>
        d.insert(llmCostEvents).values({
          userId:
            entry.userId ??
            sql`(select ${vaults.ownerId} from ${vaults} where ${eq(vaults.id, entry.vaultId)})`,
          vaultId: entry.vaultId,
          eventType: entry.eventType,
          phase: entry.phase,
          model: entry.model,
          runId: entry.runId ?? null,
          correlationId:
            entry.correlationId ?? (entry.runId === undefined ? null : `compile-${entry.runId}`),
          promptTokens: entry.promptTokens ?? null,
          completionTokens: null,
          costUsd: entry.costUsd.toFixed(6),
        }),
      ),
  })),
);
