import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Redacted } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

const runnerPath = fileURLToPath(new URL("./fixtures/workflow-kill-runner.ts", import.meta.url));

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

const startRunner = (runId: string, mode: "pause" | "complete", sideEffectDir: string) =>
  spawn(process.execPath, ["--experimental-strip-types", runnerPath, runId, mode, sideEffectDir], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl(),
      JWT_SECRET: "workflow-kernel-test-secret",
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
  new Promise<{ readonly output: string; readonly code: number | null }>((resolve, reject) => {
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
      resolve({ output, code });
    });
  });

describe("Effect workflow kernel", () => {
  beforeAll(async () => {
    await runSql(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`DROP TABLE IF EXISTS workflow_kernel_side_effects`;
        yield* sql`DROP TABLE IF EXISTS cluster_messages, cluster_replies, cluster_migrations CASCADE`;
      }),
    );
  });

  it("workflow-kill-resume: resumes after SIGKILL with exactly-once side effects", async () => {
    const runId = `kill-resume-${crypto.randomUUID()}`;
    const sideEffectDir = await mkdtemp(join(tmpdir(), "gm-workflow-kernel-"));
    try {
      const first = startRunner(runId, "pause", sideEffectDir);
      const firstOutput = await waitForOutput(first, "KERNEL finish activity started");
      expect(firstOutput).toContain("KERNEL prepare side-effect");

      first.kill("SIGKILL");
      await new Promise<void>((resolve) => first.once("exit", () => resolve()));

      const second = startRunner(runId, "complete", sideEffectDir);
      const resumed = await waitForExit(second);
      expect(resumed.code).toBe(0);
      expect(resumed.output).not.toContain("KERNEL prepare side-effect");
      expect(resumed.output).toContain("KERNEL finish side-effect inserted");
      expect(resumed.output).toContain("KERNEL completed result=prepared+finished");
      expect((await readdir(sideEffectDir)).sort()).toEqual(
        [`${runId}-finish`, `${runId}-prepare`].sort(),
      );
    } finally {
      await rm(sideEffectDir, { recursive: true, force: true });
    }

    const result = await runSql(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const engineTables = yield* sql<{ table_name: string }>`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name LIKE 'cluster_%'
          ORDER BY table_name
        `;
        return engineTables;
      }),
    );

    expect(result.map((row) => row.table_name)).toEqual([
      "cluster_messages",
      "cluster_migrations",
      "cluster_replies",
    ]);
  }, 60_000);
});
