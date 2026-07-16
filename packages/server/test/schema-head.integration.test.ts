import * as PgClient from "@effect/sql-pg/PgClient";
import { Database, DatabaseLive as GreatMindsDatabaseLive } from "@great-minds/database";
import { sql } from "drizzle-orm";
import { Cause, Effect, Exit, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import {
  assertSchemaHead,
  EXPECTED_ALEMBIC_REVISION,
  schemaHeadMismatchMessage,
} from "../src/schema-head.ts";

const databaseUrl = () => {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
  return value;
};

const DatabaseLive = GreatMindsDatabaseLive.pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(databaseUrl()) })),
);

const run = <A>(effect: Effect.Effect<A, unknown, Database>) =>
  Effect.runPromise(effect.pipe(Effect.provide(DatabaseLive)));

describe("schema head assertion", () => {
  it("accepts the pinned Alembic head", async () => {
    await expect(run(assertSchemaHead)).resolves.toBeUndefined();
  });

  it("rejects a doctored revision with the exact message", async () => {
    try {
      await run(
        Effect.flatMap(Database, (db) =>
          db.execute(sql`update alembic_version set version_num = 'doctored'`).pipe(Effect.orDie),
        ),
      );
      const exit = await Effect.runPromiseExit(assertSchemaHead.pipe(Effect.provide(DatabaseLive)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons[0];
        expect(reason !== undefined && Cause.isDieReason(reason)).toBe(true);
        if (reason !== undefined && Cause.isDieReason(reason)) {
          expect(reason.defect).toBeInstanceOf(Error);
          expect((reason.defect as Error).message).toBe(schemaHeadMismatchMessage("doctored"));
        }
      }
    } finally {
      await run(
        Effect.flatMap(Database, (db) =>
          db
            .execute(sql`update alembic_version set version_num = ${EXPECTED_ALEMBIC_REVISION}`)
            .pipe(Effect.orDie),
        ),
      );
    }
  });
});
