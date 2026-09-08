import { readFile } from "node:fs/promises";

import * as PgClient from "@effect/sql-pg/PgClient";
import { CreateReplyRequest } from "@great-minds/domain";
import { Cause, Effect, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

const migration = await readFile(new URL(
  "../../database/drizzle/20260908155003_session_reply_requests/migration.sql",
  import.meta.url,
), "utf8");

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required for integration tests");
const SqlLive = PgClient.layer({ url: Redacted.make(databaseUrl) });
const runSql = <A>(effect: Effect.Effect<A, unknown, PgClient.PgClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqlLive)));
const decodeRequest = Schema.decodeUnknownSync(CreateReplyRequest);

const migrate = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  for (const statement of migration.split("--> statement-breakpoint")) {
    yield* sql.unsafe(statement);
  }
});

const createLegacyTable = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  yield* sql`
    CREATE TEMPORARY TABLE replies (
      id uuid PRIMARY KEY,
      session_id text,
      kind text NOT NULL,
      request jsonb NOT NULL,
      CONSTRAINT replies_kind_check CHECK (kind IN ('exchange', 'btw', 'ephemeral'))
    ) ON COMMIT DROP
  `;
});

describe("reply request migration", () => {
  it("preserves creation details, BTW anchors, query options, and already nested requests", async () => {
    await runSql(Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* createLegacyTable;
        const sessionId = crypto.randomUUID();
        const common = {
          reply_id: crypto.randomUUID(),
          exchange_id: crypto.randomUUID(),
          question: "Why?",
          mode: "btw",
          model: "custom/model",
          origin_path: "refs/source.md",
          origin_scope: "personal",
          extra_instructions: "Explain carefully.",
        };
        const origin = {
          doc_path: "refs/source.md",
          origin_scope: "personal",
          anchor: "Highlighted claim",
          paragraph: "Original passage",
          paragraph_index: 2,
        };
        const btw = {
          exchangeId: crypto.randomUUID(),
          quote: "Answer excerpt",
          blockOffset: 3,
          context: "Answer paragraph",
        };
        const create = { idempotency_key: "original-key", origin_scope: "personal", origin };
        const cases = [
          {
            kind: "exchange",
            before: { ...common, kind: "exchange", create },
            after: { ...common, session: { kind: "new", ...create } },
          },
          {
            kind: "exchange",
            before: { ...common, kind: "exchange", session_id: sessionId },
            after: { ...common, session: { kind: "existing", id: sessionId } },
          },
          {
            kind: "btw",
            before: { ...common, kind: "btw", session_id: sessionId, btw },
            after: { ...common, session: { kind: "existing", id: sessionId, btw } },
          },
          {
            kind: "exchange",
            before: { ...common, session: { kind: "existing", id: sessionId } },
            after: { ...common, session: { kind: "existing", id: sessionId } },
          },
        ];
        for (const entry of cases) {
          const id = crypto.randomUUID();
          yield* sql`INSERT INTO replies VALUES (${id}::uuid, ${sessionId}, ${entry.kind}, ${JSON.stringify(entry.before)}::jsonb)`;
        }
        yield* migrate;
        const rows = yield* sql<{ request: unknown }>`SELECT request FROM replies`;
        expect(rows).toHaveLength(cases.length);
        expect(rows.map((row) => decodeRequest(row.request))).toEqual(
          expect.arrayContaining(cases.map((entry) => decodeRequest(entry.after))),
        );
        for (const [kind, destination] of [["exchange", null], ["ephemeral", sessionId]]) {
          const invalid = yield* Effect.exit(sql.withTransaction(
            sql`INSERT INTO replies VALUES (${crypto.randomUUID()}::uuid, ${destination}, ${kind}, '{}'::jsonb)`,
          ));
          expect(invalid._tag).toBe("Failure");
        }
      }));
    }));
  });

  it("stops without rewriting or deleting historical sessionless replies", async () => {
    await runSql(Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* createLegacyTable;
        const original = { reply_id: crypto.randomUUID(), kind: "ephemeral", question: "Old question" };
        yield* sql`INSERT INTO replies VALUES (${original.reply_id}::uuid, NULL, 'ephemeral', ${JSON.stringify(original)}::jsonb)`;
        const result = yield* Effect.exit(sql.withTransaction(migrate));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(Cause.pretty(result.cause)).toContain("Historical sessionless replies require review");
        }
        const rows = yield* sql<{ session_id: string | null; request: unknown }>`SELECT session_id, request FROM replies`;
        expect(rows).toEqual([{ session_id: null, request: original }]);
      }));
    }));
  });
});
