import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  };
  await run("pnpm", ["--filter", "@great-minds/database", "migrate"], env);
  const selectors = process.argv.slice(2);
  await run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      "packages/server/vitest.config.ts",
      "--no-file-parallelism",
      ...(selectors.length > 0
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
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
