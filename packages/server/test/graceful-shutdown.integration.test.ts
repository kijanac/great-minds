import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Option, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { openLocalConditionalObjectStore } from "../src/storage/local-conditional-object-store.ts";
import { failure } from "./fixtures/history-storage.ts";
import { resetWorkflowQueue } from "./fixtures/reply-history-database.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const databaseUrl = () => {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
  return value;
};

const availablePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("failed to allocate a port"));
        return;
      }
      probe.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });

const ServerListening = Schema.fromJsonString(
  Schema.Struct({ event: Schema.Literal("server_listening"), url: Schema.String }),
);
const decodeServerListening = Schema.decodeUnknownOption(ServerListening);

const mainEnv = (dataDir: string, port: number) => ({
  ...process.env,
  DATABASE_URL: databaseUrl(),
  JWT_SECRET: "graceful-shutdown-test-secret",
  STORAGE_BACKEND: "local",
  DATA_DIR: dataDir,
  HOST: "127.0.0.1",
  PORT: String(port),
});

const runAdmin = (dataDir: string, port: number, args: readonly string[]) =>
  new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "packages/server/src/main.ts", ...args],
        { cwd: repoRoot, env: mainEnv(dataDir, port), stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, stdout, stderr }));
    },
  );

const startMain = (dataDir: string, port: number) => {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "packages/server/src/main.ts", "serve"],
    { cwd: repoRoot, env: mainEnv(dataDir, port), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let pendingLine = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  const listening = new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      const lines = (pendingLine + chunk).split("\n");
      pendingLine = lines.pop() ?? "";
      for (const line of lines) {
        const event = decodeServerListening(line);
        if (Option.isSome(event)) resolve(event.value.url);
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(
        new Error(`main exited before listening (${String(code)}/${String(signal)})\n${output}`),
      ),
    );
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  };
  return { child, listening, stop };
};

describe("production process lifetime", () => {
  beforeEach(resetWorkflowQueue);

  it("runs admin commands beside a server on local storage", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "gm-admin-"));
    const port = await availablePort();
    const main = startMain(dataDir, port);
    try {
      const url = await main.listening;
      const created = await runAdmin(dataDir, port, [
        "keys",
        "create",
        "--email",
        "operator-made@example.com",
      ]);
      expect(created.stderr).not.toContain("LocalHistoryWriterBusy");
      expect(created.code).toBe(0);
      const key = created.stdout.trim();
      expect(key).toMatch(/^gm_/);
      const vaults = await fetch(`${url}/v1/vaults`, {
        headers: { authorization: `Bearer ${key}` },
      });
      expect(vaults.status).toBe(200);
      const body = (await vaults.json()) as { readonly items: readonly unknown[] };
      expect(body.items).toHaveLength(1);
      const code = await runAdmin(dataDir, port, [
        "users",
        "code",
        "--email",
        "operator-made@example.com",
      ]);
      expect(code.code).toBe(0);
      expect(code.stdout.trim()).not.toBe("");
    } finally {
      await main.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("SIGTERM closes the server, releases the local history writer lock and exits 0", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "gm-shutdown-"));
    const main = startMain(dataDir, await availablePort());
    try {
      const url = await main.listening;
      expect((await fetch(`${url}/health`)).status).toBe(200);
      const whileServing = await Effect.runPromise(
        Effect.scoped(Effect.exit(openLocalConditionalObjectStore(dataDir))),
      );
      expect(failure(whileServing)).toMatchObject({ _tag: "LocalHistoryWriterBusy" });

      const exited = once(main.child, "exit");
      main.child.kill("SIGTERM");
      expect(await exited).toEqual([0, null]);

      await Effect.runPromise(Effect.scoped(openLocalConditionalObjectStore(dataDir)));
      await expect(fetch(`${url}/health`)).rejects.toThrow();
    } finally {
      await main.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
