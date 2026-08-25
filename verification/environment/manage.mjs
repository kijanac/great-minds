import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";

const environmentDir = dirname(fileURLToPath(import.meta.url));
const expectedCommit = "c8c9e57";
const stateDir = join(environmentDir, ".state");
const logsDir = join(stateDir, "logs");
const composeFile = join(environmentDir, "docker-compose.yml");
const defaultSourceRoot = resolve(environmentDir, "../../../great_minds");
const databaseUrl = "postgresql://great_minds:great_minds@127.0.0.1:55435/gm_product_verification";
const webUrl = "http://localhost:5173";
const apiUrl = "http://127.0.0.1:8000";
const fixtureUrl = "http://127.0.0.1:4174";
const browserSessions = [
  "gm-verification-owner",
  "gm-verification-editor",
  "gm-verification-viewer",
  "gm-verification-nonmember",
];

const loadLocalEnv = () => {
  const path = join(environmentDir, ".env.local");
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match === null) throw new Error(`Invalid .env.local line: ${rawLine}`);
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    const quoted = /^(?:"([\s\S]*)"|'([\s\S]*)')$/.exec(rawValue.trim());
    process.env[key] = quoted === null ? rawValue.trim() : (quoted[1] ?? quoted[2] ?? "");
  }
};

loadLocalEnv();
const sourceRoot = resolve(process.env.GM_SOURCE_ROOT ?? defaultSourceRoot);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const captured = options.capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}${captured}`);
  }
  return result;
};

const captured = (command, args, options = {}) =>
  run(command, args, { ...options, capture: true }).stdout.trim();

const assertBaseline = () => {
  if (!existsSync(join(sourceRoot, ".git"))) {
    throw new Error(`Great Minds source repository not found at ${sourceRoot}`);
  }
  const head = captured("git", ["-C", sourceRoot, "rev-parse", "--short", "HEAD"]);
  if (head !== expectedCommit) {
    throw new Error(`Great Minds must be at ${expectedCommit}; found ${head}`);
  }
  const trackedChanges = captured("git", [
    "-C",
    sourceRoot,
    "status",
    "--short",
    "--untracked-files=no",
  ]);
  if (trackedChanges !== "") {
    throw new Error(
      `Great Minds has tracked changes; verification needs a clean ${expectedCommit} baseline`,
    );
  }
  if (
    !existsSync(join(sourceRoot, "node_modules")) ||
    !existsSync(join(sourceRoot, "web", "node_modules"))
  ) {
    throw new Error(
      "Great Minds dependencies are missing; restore the pinned workspace before starting verification",
    );
  }
};

const pidPath = (name) => join(stateDir, `${name}.pid`);
const readPid = (name) => {
  const path = pidPath(name);
  if (!existsSync(path)) return undefined;
  const value = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(value) && value > 1 ? value : undefined;
};

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const serviceAlive = (name) => {
  const pid = readPid(name);
  return pid !== undefined && pidAlive(pid);
};

const fetchOk = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
};

const tcpOk = (host, port) =>
  new Promise((resolvePromise) => {
    const socket = connect({ host, port });
    const finish = (result) => {
      socket.destroy();
      resolvePromise(result);
    };
    socket.setTimeout(2_000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });

const waitFor = async (name, url, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fetchOk(url)) return;
    if (!serviceAlive(name)) {
      const logPath = join(logsDir, `${name}.log`);
      const log = existsSync(logPath)
        ? readFileSync(logPath, "utf8").split("\n").slice(-30).join("\n")
        : "";
      throw new Error(`${name} exited before becoming ready${log === "" ? "" : `:\n${log}`}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`${name} did not become ready at ${url} within ${timeoutMs} ms`);
};

const startDetached = async ({ name, command, args, cwd, env, health }) => {
  if (serviceAlive(name)) {
    if (!(await fetchOk(health)))
      throw new Error(`${name} process is alive but ${health} is not healthy`);
    return;
  }

  const stalePid = pidPath(name);
  if (existsSync(stalePid)) unlinkSync(stalePid);
  if (await fetchOk(health)) {
    throw new Error(`${health} is already served by a process this harness does not own`);
  }

  mkdirSync(logsDir, { recursive: true });
  const logFd = openSync(join(logsDir, `${name}.log`), "a", 0o600);
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  writeFileSync(pidPath(name), `${child.pid}\n`, { mode: 0o600 });
  await waitFor(name, health);
};

const stopService = async (name) => {
  const pid = readPid(name);
  if (pid === undefined) return;
  if (pidAlive(pid)) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
    const deadline = Date.now() + 8_000;
    while (pidAlive(pid) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
    if (pidAlive(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  }
  const path = pidPath(name);
  if (existsSync(path)) unlinkSync(path);
};

const compose = (args, options = {}) =>
  run("docker", ["compose", "-f", composeFile, ...args], options);

const start = async () => {
  assertBaseline();
  mkdirSync(stateDir, { recursive: true });
  chmodSync(stateDir, 0o700);
  mkdirSync(join(stateDir, "data"), { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  compose(["up", "-d", "--wait", "db"]);
  run("pnpm", ["--dir", sourceRoot, "--filter", "@great-minds/database", "migrate"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  await startDetached({
    name: "fixtures",
    command: process.execPath,
    args: [join(environmentDir, "fixture-server.mjs")],
    cwd: environmentDir,
    env: {
      ...process.env,
      FIXTURE_HOST: "127.0.0.1",
      FIXTURE_PORT: "4174",
    },
    health: `${fixtureUrl}/health`,
  });

  await startDetached({
    name: "api",
    command: process.execPath,
    args: ["--experimental-strip-types", join(sourceRoot, "packages/server/src/main.ts")],
    cwd: sourceRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      JWT_SECRET: process.env.JWT_SECRET ?? "gm-product-verification-only-jwt-secret",
      DATA_DIR: join(stateDir, "data"),
      STORAGE_BACKEND: "local",
      SUPPRESS_AUTH: "true",
      ALLOW_PRIVATE_URL_FETCH: "true",
      HOST: "127.0.0.1",
      PORT: "8000",
      CORS_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
      WEBAUTHN_RP_ID: "localhost",
      WEBAUTHN_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
    },
    health: `${apiUrl}/health`,
  });

  await startDetached({
    name: "web",
    command: "pnpm",
    args: [
      "--prefix",
      join(sourceRoot, "web"),
      "run",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      "5173",
      "--strictPort",
    ],
    cwd: sourceRoot,
    env: {
      ...process.env,
      VITE_SUPPRESS_AUTH: "true",
    },
    health: `${webUrl}/login`,
  });

  run(process.execPath, [join(environmentDir, "seed.mjs")], {
    env: {
      ...process.env,
      DATA_DIR: join(stateDir, "data"),
      GM_VERIFICATION_STATE_DIR: stateDir,
      GM_EXPECTED_COMMIT: expectedCommit,
    },
  });
  run(process.execPath, [join(environmentDir, "smoke.mjs")]);
};

const closeBrowserSessions = () => {
  for (const session of browserSessions) {
    run("agent-browser", ["--session", session, "close"], { allowFailure: true, capture: true });
  }
};

const stop = async ({ database = true } = {}) => {
  closeBrowserSessions();
  await stopService("web");
  await stopService("api");
  await stopService("fixtures");
  if (database) compose(["stop", "db"], { allowFailure: true });
};

const reset = async () => {
  await stop({ database: false });
  compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true });
  rmSync(stateDir, { recursive: true, force: true });
  await start();
};

const readManifestSummary = () => {
  const path = join(stateDir, "manifest.json");
  if (!existsSync(path)) return undefined;
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  return {
    generated_at: manifest.generated_at,
    primary_vault: manifest.vaults?.primary,
    fixture_counts: {
      sources: manifest.fixtures?.sources?.length ?? 0,
      articles: manifest.fixtures?.articles?.length ?? 0,
      references: manifest.fixtures?.reference === undefined ? 0 : 1,
      sessions: Object.keys(manifest.fixtures?.sessions ?? {}).length,
    },
    providers: manifest.providers,
    accounts: Object.fromEntries(
      Object.entries(manifest.accounts ?? {}).map(([role, account]) => [role, account.email]),
    ),
  };
};

const status = async () => {
  const sourceHead = existsSync(join(sourceRoot, ".git"))
    ? captured("git", ["-C", sourceRoot, "rev-parse", "--short", "HEAD"])
    : "missing";
  const output = {
    source: { root: sourceRoot, expected: expectedCommit, actual: sourceHead },
    services: {
      database: await tcpOk("127.0.0.1", 55435),
      api: { pid: readPid("api") ?? null, healthy: await fetchOk(`${apiUrl}/health`), url: apiUrl },
      web: { pid: readPid("web") ?? null, healthy: await fetchOk(`${webUrl}/login`), url: webUrl },
      fixtures: {
        pid: readPid("fixtures") ?? null,
        healthy: await fetchOk(`${fixtureUrl}/health`),
        url: fixtureUrl,
      },
    },
    manifest: readManifestSummary() ?? null,
    browser_states: Object.fromEntries(
      ["owner", "editor", "viewer", "nonmember"].map((role) => [
        role,
        existsSync(join(stateDir, "browser", `${role}.json`)),
      ]),
    ),
  };
  console.log(JSON.stringify(output, null, 2));
};

const command = process.argv[2] ?? "status";
try {
  switch (command) {
    case "start":
      await start();
      await status();
      break;
    case "stop":
      await stop();
      await status();
      break;
    case "reset":
      await reset();
      await status();
      break;
    case "status":
      await status();
      break;
    default:
      throw new Error(`Unknown command ${command}; use start, stop, reset, or status`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
