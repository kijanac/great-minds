import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Redacted } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

const runnerPath = fileURLToPath(new URL("./fixtures/compile-resume-runner.ts", import.meta.url));
const ids = {
  user: "30000000-0000-4000-8000-000000000001",
  vault: "30000000-0000-4000-8000-000000000002",
  resumeIntent: "30000000-0000-4000-8000-000000000003",
  resumeRun: "30000000-0000-4000-8000-000000000004",
  cancelIntent: "30000000-0000-4000-8000-000000000005",
  cancelRun: "30000000-0000-4000-8000-000000000006",
} as const;

const databaseUrl = () => {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value.length === 0) throw new Error("DATABASE_URL is required");
  return value;
};
const SqlLive = PgClient.layer({ url: Redacted.make(databaseUrl()) });
const runSql = <A>(effect: Effect.Effect<A, unknown, PgClient.PgClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqlLive)));

const seedRun = (runId: string) =>
  runSql(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`insert into pipeline_runs(id,vault_id,trigger,status,current_phase,phase_status,progress_steps) values (${runId}::uuid,${ids.vault}::uuid,'manual','pending','','','[]'::jsonb)`;
    }),
  );

const start = (
  mode: "pause" | "resume" | "cancel",
  intentId: string,
  runId: string,
  markerDir: string,
) =>
  spawn(
    process.execPath,
    ["--experimental-strip-types", runnerPath, mode, intentId, ids.vault, runId, markerDir],
    {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl(),
        JWT_SECRET: "compile-resume-secret",
        DATA_DIR: markerDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

const waitForOutput = (child: ReturnType<typeof start>, marker: string, timeoutMs = 20_000) =>
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

const waitForExit = (child: ReturnType<typeof start>, timeoutMs = 30_000) =>
  new Promise<{ output: string; code: number | null }>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Runner did not exit. Output:\n${output}`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ output, code });
    });
  });

describe("M4.3a compile workflow durability", () => {
  beforeEach(async () => {
    await runSql(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`drop table if exists cluster_messages, cluster_replies, cluster_migrations cascade`;
        yield* sql`delete from users`;
        yield* sql`insert into users(id,email) values (${ids.user}::uuid,'compile-resume@example.com')`;
        yield* sql`insert into vaults(id,name,owner_id) values (${ids.vault}::uuid,'Compile Resume',${ids.user}::uuid)`;
      }),
    );
  });

  it("SIGKILL resume journals the completed ingest phase boundary", async () => {
    await seedRun(ids.resumeRun);
    const markerDir = await mkdtemp(join(tmpdir(), "gm-compile-resume-"));
    try {
      const first = start("pause", ids.resumeIntent, ids.resumeRun, markerDir);
      const firstOutput = await waitForOutput(first, "COMPILE extract started");
      expect(firstOutput).toContain("COMPILE ingest executed");
      first.kill("SIGKILL");
      await new Promise<void>((resolve) => first.once("exit", () => resolve()));

      const second = start("resume", ids.resumeIntent, ids.resumeRun, markerDir);
      const resumed = await waitForExit(second);
      expect(resumed.code).toBe(0);
      expect(resumed.output).not.toContain("COMPILE ingest executed");
      expect(resumed.output).toContain("COMPILE result=Failure");
      expect((await readdir(markerDir)).filter((entry) => entry === "ingest")).toHaveLength(1);
      const failureJson = /COMPILE failure=(\{.*\})/.exec(resumed.output)?.[1];
      expect(failureJson).toBeDefined();
      expect(JSON.parse(failureJson ?? "{}") as unknown).toEqual({
        _tag: "CompilePhaseNotPorted",
        phase: "extract",
        message: "resume seam",
      });
      const rows = await runSql(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{
            current_phase: string;
            error: string | null;
          }>`select current_phase,error from pipeline_runs where id=${ids.resumeRun}::uuid`;
        }),
      );
      expect(rows[0]).toEqual({ current_phase: "extract", error: "resume seam" });
    } finally {
      await rm(markerDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("cancellation interrupts a mid-phase workflow and cancelled remains terminal", async () => {
    await seedRun(ids.cancelRun);
    const markerDir = await mkdtemp(join(tmpdir(), "gm-compile-cancel-"));
    try {
      const runner = start("cancel", ids.cancelIntent, ids.cancelRun, markerDir);
      const result = await waitForExit(runner);
      expect(result.code).toBe(0);
      expect(result.output).toContain("COMPILE extract started");
      expect(result.output).toContain("COMPILE cancelled execution=");
      const rows = await runSql(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{
            status: string;
            phase_status: string;
          }>`select status,phase_status from pipeline_runs where id=${ids.cancelRun}::uuid`;
        }),
      );
      expect(rows[0]).toEqual({ status: "cancelled", phase_status: "failed" });
    } finally {
      await rm(markerDir, { recursive: true, force: true });
    }
  }, 60_000);
});
