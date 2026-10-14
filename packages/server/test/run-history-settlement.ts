import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const compose = [
  "compose",
  "--project-name",
  `gm_history_${randomUUID()}`,
  "--file",
  fileURLToPath(new URL("./docker-compose.history.yml", import.meta.url)),
];
const output = promisify(execFile);
let active: ChildProcess | undefined;
let interrupted: NodeJS.Signals | undefined;
let compilerDirectory: string | undefined;
const interrupt = (signal: NodeJS.Signals) => {
  interrupted = signal;
  active?.kill(signal);
};
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

const run = (command: string, args: readonly string[], env = process.env) =>
  new Promise<void>((resolve, reject) => {
    if (interrupted !== undefined) {
      reject(new Error(`History tests interrupted by ${interrupted}`));
      return;
    }
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    active = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      active = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? code}`));
    });
  });

try {
  const selectors = process.argv.slice(2);
  const all = selectors[0] === "--all";
  let binary = process.env.TYPST_BINARY;
  if (all) {
    await run("node", [
      "--experimental-strip-types",
      "packages/server/scripts/install-publication-fonts.ts",
    ]);
    if (binary === undefined) {
      if (process.platform !== "linux")
        throw new Error("Set TYPST_BINARY to Typst 0.15.1 on non-Linux hosts");
      compilerDirectory = await mkdtemp(join(tmpdir(), "great-minds-test-typst-"));
      binary = join(compilerDirectory, "typst");
      await run("docker", [...compose, "create", "typst"]);
      await run("docker", [...compose, "cp", "typst:/bin/typst", binary]);
    }
  }
  await run("docker", [...compose, "up", "--detach", "--wait", "db"]);
  const { stdout } = await output("docker", [...compose, "port", "db", "5432"], { cwd: root });
  const databaseUrl = `postgresql://postgres:disposable-history-test@${stdout.trim()}/gm_reply_history_test`;
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    REPLY_HISTORY_TEST_DATABASE_URL: databaseUrl,
    OPENROUTER_API_KEY: "",
    PARALLEL_API_KEY: "",
    RUN_LIVE_LLM_SMOKE: "0",
    ...(binary === undefined ? {} : { TYPST_BINARY: binary }),
  };
  await run("pnpm", ["--filter", "@great-minds/database", "migrate"], env);
  await run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      "packages/server/vitest.config.ts",
      "--no-file-parallelism",
      ...(all
        ? ["packages/server/test", ...selectors.slice(1)]
        : selectors.length > 0
          ? selectors
          : [
              "packages/server/test/reply-admission.integration.test.ts",
              "packages/server/test/reply-settlement.integration.test.ts",
              "packages/server/test/conversation-history-store.test.ts",
            ]),
    ],
    env,
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    const result = await output("docker", [...compose, "down", "--volumes", "--remove-orphans"], {
      cwd: root,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  if (compilerDirectory !== undefined)
    await rm(compilerDirectory, { recursive: true, force: true });
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
