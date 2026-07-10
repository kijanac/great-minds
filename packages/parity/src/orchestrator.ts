import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareResponses } from "./diff.ts";
import { rawKeys, resetDatabase, resetStorage, seedDeletionCompanionVault, seedReadFixture } from "./fixture.ts";
import type { Backend, CapturedResponse, RequestSpec } from "./http.ts";
import { requestBackend } from "./http.ts";
import {
  buildReadManifest,
  decisionIds,
  endpointExclusions,
  requiredContractEndpoints,
  type CredentialName,
  type CredentialSet,
  type DecisionId,
  type ManifestEntry,
  type Normalization,
} from "./manifest.ts";
import { summarizeRun, writeReport, type RequestReport, type RunReport } from "./report.ts";

type RunnerConfig = {
  readonly repoRoot: string;
  readonly databaseUrl: string;
  readonly dataDir: string;
  readonly reportPath: string;
  readonly runDir: string;
  readonly logDir: string;
  readonly pythonPort: number;
  readonly typescriptPort: number;
};

type ManagedChild = {
  readonly name: string;
  readonly process: ChildProcess;
  readonly log: WriteStream;
  readonly close: () => Promise<void>;
};

type MutationCapture = {
  readonly entry: ManifestEntry;
  readonly response: CapturedResponse;
};

type TokenPair = {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly token_type: "bearer";
};

const currentFile = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(currentFile), "..");
const defaultRepoRoot = resolve(packageRoot, "../..");

const dockerArgs = [
  "compose",
  "-p",
  "gm_parity_m2",
  "-f",
  "docker-compose.parity.yml",
] as const;

const baseEnv = (config: RunnerConfig) => ({
  ...process.env,
  DATABASE_URL: config.databaseUrl,
  JWT_SECRET: "parity-jwt-secret",
  SUPPRESS_AUTH: "true",
  STORAGE_BACKEND: "local",
  DATA_DIR: config.dataDir,
  RESEND_API_KEY: "parity-resend-key",
  RESEND_FROM_EMAIL: "login@example.test",
  UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? "/tmp/gm-uv-cache",
  PYTHONPATH: join(config.repoRoot, "src"),
});

const commandOutput = (stdout: string, stderr: string) =>
  [stdout.trim(), stderr.trim()].filter((part) => part.length > 0).join("\n");

const runCommand = async (
  config: RunnerConfig,
  command: string,
  args: readonly string[],
  options: { readonly allowFailure?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
) =>
  new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: config.repoRoot,
      env: options.env ?? baseEnv(config),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || options.allowFailure === true) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited ${code ?? "unknown"}\n${commandOutput(stdout, stderr)}`,
        ),
      );
    });
  });

const startChild = async (
  config: RunnerConfig,
  name: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<ManagedChild> => {
  const logPath = join(config.logDir, `${name}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  const child = spawn(command, args, {
    cwd: config.repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  return {
    name,
    process: child,
    log,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolvePromise) => {
          const timeout = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
            resolvePromise();
          }, 5_000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolvePromise();
          });
        });
      }
      await new Promise<void>((resolvePromise) => {
        log.end(resolvePromise);
      });
    },
  };
};

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const waitForHealth = async (child: ManagedChild, url: string) => {
  const started = Date.now();
  while (Date.now() - started < 45_000) {
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      throw new Error(`${child.name} exited before health check passed`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      await sleep(500);
      continue;
    }
    await sleep(500);
  }
  throw new Error(`${child.name} did not become healthy at ${url}`);
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object response");
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown, label: string) => {
  if (typeof value !== "string") {
    throw new Error(`expected ${label} to be a string`);
  }
  return value;
};

const parseTokenPair = (body: unknown): TokenPair => {
  const record = asRecord(body);
  const tokenType = record.token_type;
  if (tokenType !== "bearer") {
    throw new Error("expected bearer token pair");
  }
  return {
    access_token: asString(record.access_token, "access_token"),
    refresh_token: asString(record.refresh_token, "refresh_token"),
    token_type: "bearer",
  };
};

const acquireTokens = async (backend: Backend): Promise<CredentialSet> => {
  const verify = async (email: string) => {
    const response = await requestBackend(backend, {
      id: `token-${email}`,
      label: `token ${email}`,
      method: "POST",
      path: "/v1/auth/verify-code",
      body: { email, code: "000000" },
    });
    if (response.status !== 200) {
      throw new Error(`${backend.name} token acquisition failed for ${email}: ${response.text}`);
    }
    return parseTokenPair(response.body).access_token;
  };
  return {
    aliceJwt: await verify("alice@example.com"),
    bobJwt: await verify("bob@example.com"),
    carolJwt: await verify("carol@example.com"),
    malloryJwt: await verify("mallory@example.com"),
    aliceApiKey: rawKeys.aliceActive,
  };
};

const credentialFor = (
  credentials: CredentialSet,
  credentialName: CredentialName | undefined,
): string | undefined => {
  if (credentialName === undefined) {
    return undefined;
  }
  return credentials[credentialName];
};

const bearerForEntry = (credentials: CredentialSet, entry: ManifestEntry) =>
  entry.literalBearer ?? credentialFor(credentials, entry.auth);

const executeManifestEntry = async (
  backend: Backend,
  credentials: CredentialSet,
  entry: ManifestEntry,
) =>
  requestBackend(backend, {
    id: entry.id,
    label: entry.label,
    method: entry.method,
    path: entry.path,
    body: entry.body,
    bearer: bearerForEntry(credentials, entry),
  });

const mask = (path: string, label: string): Normalization => ({ kind: "mask", path, label });

const mutationEntry = (
  id: string,
  label: string,
  method: string,
  path: string,
  coverage: string,
  options: {
    readonly pathTemplate?: string;
    readonly body?: unknown;
    readonly normalize?: readonly Normalization[];
    readonly decision?: ManifestEntry["decision"];
    readonly ignoreContentType?: boolean;
  } = {},
): ManifestEntry => ({
  id,
  phase: "mutation",
  label,
  method,
  path,
  pathTemplate: options.pathTemplate ?? path,
  coverage,
  body: options.body,
  ignoreContentType: options.ignoreContentType,
  normalize: options.normalize,
  decision: options.decision,
});

const executeMutation = async (
  backend: Backend,
  databaseUrl: string,
  dataDir: string,
): Promise<readonly MutationCapture[]> => {
  await resetDatabase(databaseUrl);
  await resetStorage(dataDir);
  const captures: MutationCapture[] = [];
  const send = async (entry: ManifestEntry, bearer?: string) => {
    const request: RequestSpec = {
      id: entry.id,
      label: entry.label,
      method: entry.method,
      path: entry.path,
      body: entry.body,
      bearer,
    };
    const response = await requestBackend(backend, request);
    captures.push({ entry, response });
    return response;
  };

  await send(
    mutationEntry(
      "mutation-request-code-invalid",
      "request-code invalid email",
      "POST",
      "/v1/auth/request-code",
      "POST /auth/request-code",
      { body: { email: "not-email" }, decision: "D6" },
    ),
  );
  await send(
    mutationEntry(
      "mutation-request-code-valid",
      "request-code valid suppressed auth",
      "POST",
      "/v1/auth/request-code",
      "POST /auth/request-code",
      { body: { email: "mutation@example.com" }, ignoreContentType: true },
    ),
  );
  const verifyResponse = await send(
    mutationEntry(
      "mutation-verify-code",
      "verify-code creates user and default vault",
      "POST",
      "/v1/auth/verify-code",
      "POST /auth/verify-code",
      {
        body: { email: "mutation@example.com", code: "000000" },
        normalize: [
          mask("access_token", "access_token"),
          mask("refresh_token", "refresh_token"),
        ],
      },
    ),
  );
  const firstPair = parseTokenPair(verifyResponse.body);
  await seedDeletionCompanionVault(databaseUrl, "mutation@example.com");

  const refreshResponse = await send(
    mutationEntry("mutation-refresh", "refresh rotates token", "POST", "/v1/auth/refresh", "POST /auth/refresh", {
      body: { refresh_token: firstPair.refresh_token },
      normalize: [mask("access_token", "access_token"), mask("refresh_token", "refresh_token")],
    }),
  );
  const rotatedPair = parseTokenPair(refreshResponse.body);
  await send(
    mutationEntry(
      "mutation-refresh-reuse",
      "refresh reuse rejected",
      "POST",
      "/v1/auth/refresh",
      "POST /auth/refresh",
      { body: { refresh_token: firstPair.refresh_token } },
    ),
  );

  const createKeyResponse = await send(
    mutationEntry(
      "mutation-api-key-create",
      "create API key",
      "POST",
      "/v1/auth/api-keys",
      "POST /auth/api-keys",
      {
        body: { label: "parity automation" },
        normalize: [
          mask("id", "api_key_id"),
          mask("created_at", "created_at"),
          mask("raw_key", "raw_api_key"),
        ],
      },
    ),
    rotatedPair.access_token,
  );
  const createdKey = asRecord(createKeyResponse.body);
  const createdKeyId = asString(createdKey.id, "api key id");
  const createdRawKey = asString(createdKey.raw_key, "raw api key");

  await send(
    mutationEntry("mutation-api-key-list", "list API keys", "GET", "/v1/auth/api-keys", "GET /auth/api-keys", {
      normalize: [mask("*.id", "api_key_id"), mask("*.created_at", "created_at")],
    }),
    rotatedPair.access_token,
  );
  await send(
    mutationEntry(
      "mutation-api-key-delete-missing",
      "delete missing API key",
      "DELETE",
      "/v1/auth/api-keys/00000000-0000-4000-8000-000000009999",
      "DELETE /auth/api-keys/{key_id}",
      { pathTemplate: "/v1/auth/api-keys/{missing_key_id}" },
    ),
    rotatedPair.access_token,
  );
  await send(
    mutationEntry(
      "mutation-api-key-delete-created",
      "delete created API key",
      "DELETE",
      `/v1/auth/api-keys/${createdKeyId}`,
      "DELETE /auth/api-keys/{key_id}",
      { pathTemplate: "/v1/auth/api-keys/{created_key_id}", ignoreContentType: true },
    ),
    rotatedPair.access_token,
  );
  await send(
    mutationEntry(
      "mutation-api-key-list-revoked",
      "list API keys after revoke",
      "GET",
      "/v1/auth/api-keys",
      "GET /auth/api-keys",
      { normalize: [mask("*.id", "api_key_id"), mask("*.created_at", "created_at")] },
    ),
    rotatedPair.access_token,
  );
  await send(
    mutationEntry(
      "mutation-api-key-revoked-auth",
      "revoked API key no longer authenticates",
      "GET",
      "/v1/auth/api-keys",
      "GET /auth/api-keys",
    ),
    createdRawKey,
  );
  await send(
    mutationEntry("mutation-delete-me-invalid", "delete me invalid confirm", "DELETE", "/v1/auth/me", "DELETE /auth/me", {
      body: { confirm: "delete" },
      decision: "D6",
    }),
    rotatedPair.access_token,
  );
  await send(
    mutationEntry("mutation-delete-me", "delete me cascade", "DELETE", "/v1/auth/me", "DELETE /auth/me", {
      body: { confirm: "DELETE" },
      ignoreContentType: true,
    }),
    rotatedPair.access_token,
  );
  return captures;
};

const compareMutationFlows = (
  pythonFlow: readonly MutationCapture[],
  typescriptFlow: readonly MutationCapture[],
): readonly RequestReport[] => {
  if (pythonFlow.length !== typescriptFlow.length) {
    throw new Error("mutation flow lengths differ");
  }
  return pythonFlow.map((pythonCapture, index) => {
    const typescriptCapture = typescriptFlow[index];
    if (typescriptCapture === undefined || typescriptCapture.entry.id !== pythonCapture.entry.id) {
      throw new Error(`mutation flow entry mismatch at ${index}`);
    }
    return {
      entry: pythonCapture.entry,
      result: compareResponses(
        pythonCapture.entry,
        pythonCapture.response,
        typescriptCapture.response,
      ),
    };
  });
};

const compareReadMatrix = async (
  python: Backend,
  typescript: Backend,
  pythonCredentials: CredentialSet,
  typescriptCredentials: CredentialSet,
): Promise<readonly RequestReport[]> => {
  const manifest = buildReadManifest(pythonCredentials);
  const reports: RequestReport[] = [];
  for (const entry of manifest) {
    const [pythonResponse, typescriptResponse] = await Promise.all([
      executeManifestEntry(python, pythonCredentials, entry),
      executeManifestEntry(typescript, typescriptCredentials, entry),
    ]);
    reports.push({
      entry,
      result: compareResponses(entry, pythonResponse, typescriptResponse),
    });
  }
  return reports;
};

const validateCoverage = (requests: readonly RequestReport[], decisionHits: ReadonlyMap<DecisionId, number>) => {
  const covered = new Set(requests.map((request) => request.entry.coverage));
  const excluded = new Set(endpointExclusions.map((item) => item.split(" -- ", 1)[0]));
  const missing = requiredContractEndpoints.filter(
    (endpoint) => !covered.has(endpoint) && !excluded.has(endpoint),
  );
  if (missing.length > 0) {
    throw new Error(`missing manifest coverage: ${missing.join(", ")}`);
  }
  const missingDecisions = decisionIds.filter((decision) => (decisionHits.get(decision) ?? 0) === 0);
  if (missingDecisions.length > 0) {
    throw new Error(`missing decision-rule hits: ${missingDecisions.join(", ")}`);
  }
};

const countDecisionHits = (requests: readonly RequestReport[]) => {
  const counts = new Map<DecisionId, number>();
  for (const decision of decisionIds) {
    counts.set(decision, 0);
  }
  for (const request of requests) {
    if (!request.result.ok) {
      continue;
    }
    for (const decision of request.result.decisions) {
      counts.set(decision, (counts.get(decision) ?? 0) + 1);
    }
  }
  return counts;
};

const makeConfig = async (): Promise<RunnerConfig> => {
  const repoRoot = process.env.PARITY_REPO_ROOT ?? defaultRepoRoot;
  const runDir = await mkdtemp(join(tmpdir(), "gm-parity-"));
  const logDir = join(runDir, "logs");
  await mkdir(logDir, { recursive: true });
  return {
    repoRoot,
    databaseUrl:
      process.env.PARITY_DATABASE_URL ??
      "postgresql://great_minds:great_minds@localhost:55446/gm_parity",
    dataDir: join(runDir, "data"),
    reportPath:
      process.env.PARITY_REPORT_PATH ?? join(repoRoot, "packages/parity/reports/latest.md"),
    runDir,
    logDir,
    pythonPort: Number(process.env.PARITY_PYTHON_PORT ?? "8911"),
    typescriptPort: Number(process.env.PARITY_TYPESCRIPT_PORT ?? "8912"),
  };
};

export const runParity = async () => {
  const startedAt = new Date();
  const start = process.hrtime.bigint();
  const config = await makeConfig();
  const children: ManagedChild[] = [];
  try {
    await runCommand(config, "docker", [...dockerArgs, "down", "-v", "--remove-orphans"], {
      allowFailure: true,
    });
    await runCommand(config, "docker", [...dockerArgs, "up", "-d", "--wait", "db"]);
    await runCommand(config, "uv", ["run", "alembic", "upgrade", "head"]);
    await resetStorage(config.dataDir);

    const env = baseEnv(config);
    const python = await startChild(
      config,
      "python",
      "uv",
      [
        "run",
        "uvicorn",
        "great_minds.app.api.server:create_app",
        "--factory",
        "--host",
        "127.0.0.1",
        "--port",
        String(config.pythonPort),
        "--log-level",
        "warning",
      ],
      env,
    );
    children.push(python);
    const typescript = await startChild(
      config,
      "typescript",
      "node",
      ["--experimental-strip-types", "packages/server/src/main.ts"],
      {
        ...env,
        HOST: "127.0.0.1",
        PORT: String(config.typescriptPort),
      },
    );
    children.push(typescript);

    const pythonBackend = {
      name: "python",
      baseUrl: `http://127.0.0.1:${config.pythonPort}`,
    } satisfies Backend;
    const typescriptBackend = {
      name: "typescript",
      baseUrl: `http://127.0.0.1:${config.typescriptPort}`,
    } satisfies Backend;

    await Promise.all([
      waitForHealth(python, `${pythonBackend.baseUrl}/health`),
      waitForHealth(typescript, `${typescriptBackend.baseUrl}/health`),
    ]);

    const pythonMutation = await executeMutation(pythonBackend, config.databaseUrl, config.dataDir);
    const typescriptMutation = await executeMutation(
      typescriptBackend,
      config.databaseUrl,
      config.dataDir,
    );
    const mutationReports = compareMutationFlows(pythonMutation, typescriptMutation);

    await resetDatabase(config.databaseUrl);
    await resetStorage(config.dataDir);
    await seedReadFixture(config.databaseUrl, config.dataDir);
    const [pythonCredentials, typescriptCredentials] = await Promise.all([
      acquireTokens(pythonBackend),
      acquireTokens(typescriptBackend),
    ]);
    const readReports = await compareReadMatrix(
      pythonBackend,
      typescriptBackend,
      pythonCredentials,
      typescriptCredentials,
    );

    const requests = [...mutationReports, ...readReports];
    const decisionHits = countDecisionHits(requests);
    validateCoverage(requests, decisionHits);
    const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
    const report: RunReport = {
      startedAt: startedAt.toISOString(),
      durationMs,
      mutationCount: mutationReports.length,
      readCount: readReports.length,
      endpointCount: requiredContractEndpoints.length - endpointExclusions.length,
      decisionHits,
      requests,
      exclusions: endpointExclusions,
    };
    await writeReport(config.reportPath, report);
    return {
      report,
      summary: summarizeRun(report),
      reportPath: config.reportPath,
    };
  } finally {
    for (const child of [...children].reverse()) {
      await child.close();
    }
    await runCommand(config, "docker", [...dockerArgs, "down", "-v", "--remove-orphans"], {
      allowFailure: true,
    });
    if (process.env.PARITY_KEEP_RUN_DIR !== "1") {
      await rm(config.runDir, { recursive: true, force: true });
    }
  }
};
