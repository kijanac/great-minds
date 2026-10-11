import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as PgClient from "@effect/sql-pg/PgClient";
import { Database } from "@great-minds/database";
import { CreateReplyRequest, Uuid } from "@great-minds/domain";
import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { makeReplyAdmission } from "../src/conversation-history/admission.ts";
import { parseHistory } from "../src/conversation-history/history.ts";
import { makeHistoryStore } from "../src/conversation-history/store.ts";
import { openLocalConditionalObjectStore } from "../src/storage/local-conditional-object-store.ts";
import { VaultAccessService, VaultAccessServiceLive } from "../src/vaults.ts";
import {
  replyHistoryTestDatabaseUrl,
  runHistoryDatabase,
} from "./fixtures/reply-history-database.ts";

const runnerPath = fileURLToPath(new URL("./fixtures/reply-resume-runner.ts", import.meta.url));
const runSql = <A>(effect: Effect.Effect<A, unknown, PgClient.PgClient>) =>
  runHistoryDatabase(effect);
type Mode =
  | "pause"
  | "resume"
  | "save-result"
  | "fail-result"
  | "resume-result"
  | "save-admission"
  | "resume-admission";
const startRunner = (mode: Mode, replyId: string, markerPath: string, storageRoot: string) =>
  spawn(process.execPath, ["--experimental-strip-types", runnerPath, mode, replyId, markerPath], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: {
      ...process.env,
      DATABASE_URL: replyHistoryTestDatabaseUrl,
      JWT_SECRET: "reply-resume-test-secret",
      DATA_DIR: storageRoot,
      STORAGE_BACKEND: "local",
      OPENROUTER_API_KEY: "reply-resume-test-key",
      QUERY_MODEL: "reply-resume/model",
      QUERY_FALLBACK_MODELS: "reply-resume/fallback",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
type Runner = ReturnType<typeof startRunner>;

const waitForOutput = (child: Runner, marker: string, timeoutMs = 20_000) =>
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

const waitForExit = (child: Runner, timeoutMs = 20_000) =>
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

const killRunner = (child: Runner) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });

const withReply = async (
  admit: boolean,
  use: (fixture: {
    readonly replyId: Uuid;
    readonly start: (mode: Mode) => Runner;
    readonly markers: () => Promise<readonly string[]>;
    readonly history: () => Promise<ReturnType<typeof parseHistory>>;
    readonly stop: () => Promise<void>;
  }) => Promise<void>,
) => {
  const userId = Uuid.make(randomUUID());
  const vaultId = Uuid.make(randomUUID());
  const replyId = Uuid.make(randomUUID());
  const storageRoot = await mkdtemp(join(tmpdir(), "gm-reply-resume-"));
  const markerPath = join(storageRoot, "provider-calls.txt");
  const children: Runner[] = [];
  try {
    await mkdir(join(storageRoot, "vaults", vaultId), { recursive: true });
    await writeFile(
      join(storageRoot, "vaults", vaultId, "config.yaml"),
      "name: Reply resume\nweb_search: true\n",
    );
    await writeFile(markerPath, "");
    const response = await runHistoryDatabase(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`INSERT INTO users (id, email) VALUES (${userId}::uuid, ${`${userId}@reply-history.test`})`;
        yield* sql`INSERT INTO vaults (id, name, owner_id) VALUES (${vaultId}::uuid, 'Reply resume', ${userId}::uuid)`;
        yield* sql`INSERT INTO vault_memberships (id, vault_id, user_id, role) VALUES (${randomUUID()}::uuid, ${vaultId}::uuid, ${userId}::uuid, 'OWNER')`;
        const db = yield* Database;
        const access = yield* VaultAccessService.pipe(Effect.provide(VaultAccessServiceLive));
        const histories = makeHistoryStore(yield* openLocalConditionalObjectStore(storageRoot));
        const admission = makeReplyAdmission(
          db,
          histories,
          { now: Effect.sync(() => new Date()) },
          { bytes: (size) => Effect.sync(() => new Uint8Array(randomBytes(size))) },
          access,
          true,
        );
        const input = Schema.decodeUnknownSync(CreateReplyRequest)({
          reply_id: replyId,
          exchange_id: randomUUID(),
          question: "Will this provider call repeat?",
          session: { kind: "new", idempotency_key: randomUUID() },
        });
        if (admit) return yield* admission.accept(userId, vaultId, input);
        return yield* admission.reserve(userId, vaultId, input);
      }),
    );
    await use({
      replyId,
      start: (mode) => {
        const child = startRunner(mode, replyId, markerPath, storageRoot);
        children.push(child);
        return child;
      },
      markers: async () => (await readFile(markerPath, "utf8")).trim().split("\n").filter(Boolean),
      history: async () =>
        parseHistory(
          response.session_id,
          await readFile(
            join(storageRoot, "vaults", vaultId, "sessions", `${response.session_id}.jsonl`),
          ),
        ),
      stop: () =>
        runSql(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`UPDATE replies SET stop_requested = true WHERE id = ${replyId}::uuid`;
          }),
        ),
    });
  } finally {
    await Promise.all(children.map(killRunner));
    await runSql(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`DELETE FROM users WHERE id = ${userId}::uuid`;
      }),
    );
    await rm(storageRoot, { recursive: true, force: true });
  }
};

const historyOf = (parsed: ReturnType<typeof parseHistory>) => {
  if (Result.isFailure(parsed)) throw parsed.failure;
  return parsed.success;
};

const operation = (replyId: Uuid) =>
  runSql(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{
        status: string;
        answer: string;
        error: string | null;
        generation_cursor: number;
        active_generation_step: number | null;
        settlement: unknown;
      }>`SELECT status, answer, error, generation_cursor, active_generation_step, settlement FROM replies WHERE id = ${replyId}::uuid`;
      return rows[0];
    }),
  );

describe("native reply workflow restart recovery", () => {
  it.each([false, true])(
    "recovers a killed provider turn with stop requested=%s without calling it twice",
    (stopRequested) =>
      withReply(true, async (f) => {
        const first = f.start("pause");
        const started = await waitForOutput(first, "REPLY active cursor=0");
        expect(started).toContain("REPLY provider called mode=pause");
        if (stopRequested) await f.stop();
        await killRunner(first);
        const resumed = await waitForExit(f.start("resume"));
        expect(resumed.code, resumed.output).toBe(0);
        expect(resumed.output).toContain(
          `REPLY terminal status=${stopRequested ? "stopped" : "failed"} cursor=0`,
        );
        expect(await f.markers()).toEqual(["model:pause"]);
        expect(await operation(f.replyId)).toMatchObject({
          status: stopRequested ? "stopped" : "failed",
          answer: "partial",
          generation_cursor: 0,
          active_generation_step: null,
          settlement: null,
          error: stopRequested
            ? null
            : "Reply interrupted before an external response could be saved. It was not retried automatically.",
        });
        const recorded = historyOf(await f.history()).turns[0].attempts[0].settlement;
        expect(recorded).toMatchObject({
          outcome: { status: stopRequested ? "stopped" : "failed" },
          answer: "partial",
        });
        if (!stopRequested)
          expect(recorded?.outcome).toMatchObject({ code: "external_outcome_unknown" });
      }),
    60_000,
  );

  it.each([false, true])(
    "recovers saved admission with stop requested=%s without generating before confirmation",
    (stopRequested) =>
      withReply(false, async (f) => {
        const first = f.start("save-admission");
        await waitForOutput(first, "REPLY admission saved");
        expect(await operation(f.replyId)).toMatchObject({ status: "admitting" });
        expect(await f.markers()).toEqual([]);
        expect(historyOf(await f.history()).records).toHaveLength(2);
        if (stopRequested) await f.stop();
        await killRunner(first);
        const resumed = await waitForExit(f.start("resume-admission"));
        expect(resumed.code, resumed.output).toBe(0);
        expect(await f.markers()).toEqual(stopRequested ? [] : ["model:resume-admission"]);
        expect(await operation(f.replyId)).toMatchObject({
          status: stopRequested ? "stopped" : "completed",
          settlement: null,
        });
        expect(historyOf(await f.history()).records).toHaveLength(3);
      }),
    60_000,
  );

  it.each(["save-result", "fail-result"] as const)(
    "publishes a frozen result after %s and process death without repeating model or tool calls",
    (mode) =>
      withReply(true, async (f) => {
        const first = f.start(mode);
        await waitForOutput(
          first,
          mode === "save-result"
            ? "REPLY settlement waiting"
            : "REPLY workflow complete while settling",
        );
        const frozen = await operation(f.replyId);
        expect(frozen).toMatchObject({ status: "settling", answer: "Saved once." });
        expect(frozen?.settlement).toMatchObject({
          outcome: { status: "completed" },
          answer: "Saved once.",
        });
        const calls = [`model:${mode}`, `tool:${mode}`, `model:${mode}`];
        expect(await f.markers()).toEqual(calls);
        await killRunner(first);
        const resumed = await waitForExit(f.start("resume-result"));
        expect(resumed.code, resumed.output).toBe(0);
        expect(await f.markers()).toEqual(calls);
        expect(await operation(f.replyId)).toMatchObject({
          status: "completed",
          answer: "Saved once.",
          settlement: null,
          active_generation_step: null,
        });
        const history = historyOf(await f.history());
        expect(history.records).toHaveLength(3);
        expect(history.turns[0].attempts[0].settlement).toMatchObject(frozen!.settlement!);
        expect(history.turns[0].attempts[0].settlement?.context_messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ role: "tool", tool_call_id: "durable-search" }),
          ]),
        );
      }),
    60_000,
  );
});
