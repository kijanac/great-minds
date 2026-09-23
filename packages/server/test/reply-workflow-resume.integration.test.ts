import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";

const runnerPath = fileURLToPath(new URL("./fixtures/reply-resume-runner.ts", import.meta.url));

const databaseUrl = () => {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
  return value;
};

const SqlLive = PgClient.layer({ url: Redacted.make(databaseUrl()) });
const runSql = <A>(effect: Effect.Effect<A, unknown, PgClient.PgClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqlLive)));

const startRunner = (
  mode: "pause" | "resume",
  replyId: string,
  markerPath: string,
  storageRoot: string,
) =>
  spawn(process.execPath, ["--experimental-strip-types", runnerPath, mode, replyId, markerPath], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl(),
      JWT_SECRET: "reply-resume-test-secret",
      DATA_DIR: storageRoot,
      OPENROUTER_API_KEY: "reply-resume-test-key",
      QUERY_MODEL: "reply-resume/model",
      QUERY_FALLBACK_MODELS: "reply-resume/fallback",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

const waitForOutput = (
  child: ReturnType<typeof startRunner>,
  marker: string,
  timeoutMs = 20_000,
) =>
  new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out waiting for ${marker}. Output:\n${output}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(marker)) {
        clearTimeout(timeout);
        resolve(output);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Runner exited (${String(code)}/${String(signal)}). Output:\n${output}`));
    });
  });

const waitForExit = (child: ReturnType<typeof startRunner>, timeoutMs = 20_000) =>
  new Promise<{ readonly code: number | null; readonly output: string }>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Runner did not exit. Output:\n${output}`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });

describe("reply workflow restart recovery", () => {
  it.each([false, true])("recovers a killed provider turn with stop requested=%s without calling it twice", async (stopRequested) => {
    const userId = crypto.randomUUID();
    const vaultId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const replyId = crypto.randomUUID();
    const exchangeId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const storageRoot = await mkdtemp(join(tmpdir(), "gm-reply-resume-"));
    const markerPath = join(storageRoot, "provider-calls.txt");
    const sessionDirectory = join(storageRoot, "vaults", vaultId, "sessions");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, `${sessionId}.jsonl`), [
      { type: "meta", id: sessionId, user_id: userId, query: "Will this provider call repeat?", origin: null, ts: new Date().toISOString() },
      { type: "reply", reply_id: replyId, parent_reply_id: null, exchange_id: exchangeId, question: "Will this provider call repeat?", status: "pending", messages: [], sources: [], answer: "", ts: new Date().toISOString() },
    ].map((event) => `${JSON.stringify(event)}\n`).join(""));

    await runSql(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`INSERT INTO users (id, email) VALUES (${userId}::uuid, ${`${userId}@example.com`})`;
        yield* sql`INSERT INTO vaults (id, name, owner_id) VALUES (${vaultId}::uuid, 'Reply resume', ${userId}::uuid)`;
        yield* sql`INSERT INTO vault_memberships (id, vault_id, user_id, role) VALUES (${membershipId}::uuid, ${vaultId}::uuid, ${userId}::uuid, 'OWNER')`;
        yield* sql`INSERT INTO sessions (id, vault_id, user_id, query, created_at, updated_at) VALUES (${sessionId}, ${vaultId}::uuid, ${userId}::uuid, 'Will this provider call repeat?', now(), now())`;
        yield* sql`
          INSERT INTO replies (id, vault_id, user_id, session_id, kind, status, request)
          VALUES (
            ${replyId}::uuid,
            ${vaultId}::uuid,
            ${userId}::uuid,
            ${sessionId},
            'exchange',
            'running',
            ${JSON.stringify({
              reply_id: replyId,
              exchange_id: exchangeId,
              session: { kind: "existing", id: sessionId },
              question: "Will this provider call repeat?",
              mode: "query",
            })}::jsonb
          )
        `;
      }),
    );

    try {
      const first = startRunner("pause", replyId, markerPath, storageRoot);
      const started = await waitForOutput(first, "REPLY active cursor=0");
      expect(started).toContain("REPLY provider called mode=pause");
      if (stopRequested) {
        await runSql(Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`UPDATE replies SET stop_requested = true WHERE id = ${replyId}::uuid`;
        }));
      }
      first.kill("SIGKILL");
      await new Promise<void>((resolve) => first.once("exit", () => resolve()));

      const second = startRunner("resume", replyId, markerPath, storageRoot);
      const resumed = await waitForExit(second);
      expect(resumed.code).toBe(0);
      expect(resumed.output).toContain(`REPLY terminal status=${stopRequested ? "stopped" : "failed"} cursor=0`);
      expect(resumed.output).not.toContain("REPLY provider called mode=resume");
      expect((await readFile(markerPath, "utf8")).trim().split("\n")).toEqual(["pause"]);

      const rows = await runSql(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{
            status: string;
            error: string | null;
            generation_cursor: number;
            active_generation_step: number | null;
          }>`
            SELECT status, error, generation_cursor, active_generation_step
            FROM replies
            WHERE id = ${replyId}::uuid
          `;
        }),
      );
      expect(rows).toEqual([
        {
          status: stopRequested ? "stopped" : "failed",
          error: stopRequested ? null :
            "Reply interrupted before an external response could be saved. It was not retried automatically.",
          generation_cursor: 0,
          active_generation_step: null,
        },
      ]);
      if (stopRequested) {
        const events = (await readFile(join(sessionDirectory, `${sessionId}.jsonl`), "utf8"))
          .trim().split("\n").map((line) => JSON.parse(line));
        expect(events.at(-1)).toMatchObject({ status: "stopped", answer: "partial" });
      }
    } finally {
      await runSql(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`DELETE FROM users WHERE id = ${userId}::uuid`;
        }),
      );
      await rm(storageRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
