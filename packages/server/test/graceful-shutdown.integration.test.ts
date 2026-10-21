import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { openLocalConditionalObjectStore } from "../src/storage/local-conditional-object-store.ts";
import { failure } from "./fixtures/history-storage.ts";

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

const startMain = (dataDir: string, port: number) => {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "packages/server/src/main.ts"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl(),
        JWT_SECRET: "graceful-shutdown-test-secret",
        STORAGE_BACKEND: "local",
        DATA_DIR: dataDir,
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
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
