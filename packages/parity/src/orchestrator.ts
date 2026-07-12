import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type RequestListener, type Server as NodeServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareResponses } from "./diff.ts";
import {
  assertNoTypescriptReconciliation,
  ids,
  rawKeys,
  resetDatabase,
  resetStorage,
  seedDeletionCompanionVault,
  seedDuplicateClientHashSources,
  seedNormalProposal,
  seedReadFixture,
  seedSourceDeletionFixture,
} from "./fixture.ts";
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

const dockerArgs = ["compose", "-p", "gm_parity_m2", "-f", "docker-compose.parity.yml"] as const;

const baseEnv = (config: RunnerConfig) => ({
  ...process.env,
  DATABASE_URL: config.databaseUrl,
  JWT_SECRET: "parity-jwt-secret",
  SUPPRESS_AUTH: "true",
  STORAGE_BACKEND: "local",
  DATA_DIR: config.dataDir,
  OPENROUTER_API_KEY: "parity-openrouter-key",
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

const withLocalHttpServer = async <A>(
  handler: RequestListener,
  use: (baseUrl: string) => Promise<A>,
) => {
  const server: NodeServer = createServer(handler);
  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("local HTTP parity server did not bind to a TCP port");
    }
    return await use(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
    });
  }
};

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

const encodePath = (path: string) =>
  path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

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

const parseCreatedId = (body: unknown, label: string) => {
  const id = asRecord(body).id;
  if (typeof id !== "string") {
    throw new Error(`expected ${label} to be a string; body=${JSON.stringify(body)}`);
  }
  return id;
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
  const acquireToken = async (email: string) => {
    const response = await requestBackend(backend, {
      id: `mutation-token-${email}`,
      label: `mutation token ${email}`,
      method: "POST",
      path: "/v1/auth/verify-code",
      body: { email, code: "000000" },
    });
    if (response.status !== 200) {
      throw new Error(`${backend.name} token acquisition failed for ${email}: ${response.text}`);
    }
    return parseTokenPair(response.body).access_token;
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
        normalize: [mask("access_token", "access_token"), mask("refresh_token", "refresh_token")],
      },
    ),
  );
  const firstPair = parseTokenPair(verifyResponse.body);
  await seedDeletionCompanionVault(databaseUrl, "mutation@example.com");

  const refreshResponse = await send(
    mutationEntry(
      "mutation-refresh",
      "refresh rotates token",
      "POST",
      "/v1/auth/refresh",
      "POST /auth/refresh",
      {
        body: { refresh_token: firstPair.refresh_token },
        normalize: [mask("access_token", "access_token"), mask("refresh_token", "refresh_token")],
      },
    ),
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
    mutationEntry(
      "mutation-api-key-list",
      "list API keys",
      "GET",
      "/v1/auth/api-keys",
      "GET /auth/api-keys",
      {
        normalize: [mask("*.id", "api_key_id"), mask("*.created_at", "created_at")],
      },
    ),
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

  const vaultCreateResponse = await send(
    mutationEntry(
      "mutation-vault-create",
      "create vault with config seed",
      "POST",
      "/v1/vaults",
      "POST /vaults",
      {
        body: {
          name: "Mutation Project",
          thematic_hint: "Prefer concrete debates.",
          kinds: ["movement", "debate"],
        },
        normalize: [
          mask("id", "vault_id"),
          mask("owner_id", "owner_id"),
          mask("created_at", "created_at"),
        ],
      },
    ),
    rotatedPair.access_token,
  );
  const vaultId = parseCreatedId(vaultCreateResponse.body, "vault id");

  await send(
    mutationEntry(
      "mutation-vault-config-update",
      "update vault config",
      "PATCH",
      `/v1/vaults/${vaultId}/config`,
      "PATCH /vaults/{vault_id}/config",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/config",
        body: { thematic_hint: "Updated parity steer" },
      },
    ),
    rotatedPair.access_token,
  );

  const editorInvite = await send(
    mutationEntry(
      "mutation-member-invite-editor",
      "invite editor",
      "POST",
      `/v1/vaults/${vaultId}/members`,
      "POST /vaults/{vault_id}/members",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/members",
        body: { email: "parity-editor@example.com", role: "editor" },
        normalize: [mask("user_id", "user_id")],
      },
    ),
    rotatedPair.access_token,
  );
  const editorUserId = asString(asRecord(editorInvite.body).user_id, "editor user id");
  const editorToken = await acquireToken("parity-editor@example.com");

  const memberInvite = await send(
    mutationEntry(
      "mutation-member-invite-viewer",
      "invite viewer",
      "POST",
      `/v1/vaults/${vaultId}/members`,
      "POST /vaults/{vault_id}/members",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/members",
        body: { email: "parity-member@example.com", role: "viewer" },
        normalize: [mask("user_id", "user_id")],
      },
    ),
    rotatedPair.access_token,
  );
  const memberUserId = asString(asRecord(memberInvite.body).user_id, "member user id");
  const memberToken = await acquireToken("parity-member@example.com");

  await seedDuplicateClientHashSources(databaseUrl, vaultId, "parity-client-hash");
  await send(
    mutationEntry(
      "mutation-ingest-raw",
      "raw markdown ingest",
      "POST",
      `/v1/vaults/${vaultId}/ingest`,
      "POST /vaults/{vault_id}/ingest",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/ingest",
        body: {
          content: "# Parity Raw\n\nA deterministic raw paragraph.",
          dest: "raw/docs/parity-raw.md",
          origin: "parity-fixture",
        },
      },
    ),
    rotatedPair.access_token,
  );
  await send(
    mutationEntry(
      "mutation-ingest-raw-readback",
      "raw ingest source readback",
      "GET",
      `/v1/vaults/${vaultId}/raw/sources?source_type=document&limit=10`,
      "GET /vaults/{vault_id}/raw/sources",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/raw/sources?source_type=document&limit=10",
        normalize: [mask("items.*.updated_at", "source_updated_at")],
      },
    ),
    rotatedPair.access_token,
  );

  const suggestionIntents = ["disagree", "correct", "add_context", "restructure"] as const;
  for (const intent of suggestionIntents) {
    await send(
      mutationEntry(
        `mutation-ingest-suggestion-owner-${intent}`,
        `owner suggestion ${intent}`,
        "POST",
        `/v1/vaults/${vaultId}/ingest/user-suggestion`,
        "POST /vaults/{vault_id}/ingest/user-suggestion",
        {
          pathTemplate: "/v1/vaults/{created_vault_id}/ingest/user-suggestion",
          body: {
            body: `Owner ${intent} parity suggestion.`,
            intent,
            anchored_to: `Owner Anchor ${intent}`,
            anchored_section: "owner-section",
          },
          normalize: [mask("file_path", "suggestion_path")],
        },
      ),
      rotatedPair.access_token,
    );
    await send(
      mutationEntry(
        `mutation-ingest-suggestion-editor-${intent}`,
        `editor suggestion ${intent}`,
        "POST",
        `/v1/vaults/${vaultId}/ingest/user-suggestion`,
        "POST /vaults/{vault_id}/ingest/user-suggestion",
        {
          pathTemplate: "/v1/vaults/{created_vault_id}/ingest/user-suggestion",
          body: {
            body: `Editor ${intent} parity suggestion.`,
            intent,
            anchored_to: `Editor Anchor ${intent}`,
            anchored_section: "editor-section",
          },
          normalize: [mask("file_path", "suggestion_path")],
        },
      ),
      editorToken,
    );
  }
  await send(
    mutationEntry(
      "mutation-ingest-suggestion-source-readback",
      "owner suggestion source readback",
      "GET",
      `/v1/vaults/${vaultId}/raw/sources?source_type=user&limit=10`,
      "GET /vaults/{vault_id}/raw/sources",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/raw/sources?source_type=user&limit=10",
        normalize: [
          mask("items.*.file_path", "suggestion_path"),
          mask("items.*.updated_at", "source_updated_at"),
        ],
      },
    ),
    rotatedPair.access_token,
  );
  await send(
    mutationEntry(
      "mutation-ingest-suggestion-proposal-readback",
      "editor suggestion proposal readback",
      "GET",
      `/v1/vaults/${vaultId}/proposals?status=pending&limit=10`,
      "GET /vaults/{vault_id}/proposals",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/proposals?status=pending&limit=10",
        normalize: [
          mask("items.*.id", "proposal_id"),
          mask("items.*.vault_id", "vault_id"),
          mask("items.*.created_at", "created_at"),
        ],
      },
    ),
    editorToken,
  );

  await send(
    mutationEntry(
      "mutation-ingest-check-dupes",
      "staged file duplicate hash check",
      "POST",
      `/v1/vaults/${vaultId}/ingest/staged-files/check-dupes`,
      "POST /vaults/{vault_id}/ingest/staged-files/check-dupes",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/ingest/staged-files/check-dupes",
        body: { client_hashes: ["parity-client-hash", "new-client-hash"] },
      },
    ),
    rotatedPair.access_token,
  );

  await send(
    mutationEntry(
      "mutation-ingest-staged-process-empty",
      "staged file process rejects empty files",
      "POST",
      `/v1/vaults/${vaultId}/ingest/staged-files/process`,
      "POST /vaults/{vault_id}/ingest/staged-files/process",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/ingest/staged-files/process",
        body: { job_id: ids.m32StagedEmptyRun, files: [] },
      },
    ),
    rotatedPair.access_token,
  );
  await send(
    mutationEntry(
      "mutation-ingest-staged-process",
      "staged file process spawns Absurd task",
      "POST",
      `/v1/vaults/${vaultId}/ingest/staged-files/process`,
      "POST /vaults/{vault_id}/ingest/staged-files/process",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/ingest/staged-files/process",
        body: {
          job_id: ids.m32StagedRun,
          files: [
            { name: "parity.md", size: 12, hash: "parity-staged-hash", mimetype: "text/markdown" },
          ],
        },
        normalize: [
          mask("vault_id", "vault_id"),
          mask("created_at", "created_at"),
          mask("updated_at", "updated_at"),
        ],
      },
    ),
    rotatedPair.access_token,
  );

  await withLocalHttpServer(
    (request, response) => {
      if (request.url === "/ok") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          "<html><head><title>Parity Article</title></head><body><main><h1>Parity Article</h1><p>Readable URL content.</p></main></body></html>",
        );
        return;
      }
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("failed");
    },
    async (origin) => {
      await send(
        mutationEntry(
          "mutation-jobs-url-success",
          "URL job success response envelope",
          "POST",
          `/v1/vaults/${vaultId}/jobs/url`,
          "POST /vaults/{vault_id}/jobs/url",
          {
            pathTemplate: "/v1/vaults/{created_vault_id}/jobs/url",
            body: { job_id: ids.m32UrlRun, url: `${origin}/ok` },
            normalize: [
              mask("vault_id", "vault_id"),
              mask("created_at", "created_at"),
              mask("updated_at", "updated_at"),
            ],
          },
        ),
        memberToken,
      );
      await send(
        mutationEntry(
          "mutation-jobs-url-failure",
          "URL job failed fetch response envelope",
          "POST",
          `/v1/vaults/${vaultId}/jobs/url`,
          "POST /vaults/{vault_id}/jobs/url",
          {
            pathTemplate: "/v1/vaults/{created_vault_id}/jobs/url",
            body: { job_id: ids.m32UrlFailRun, url: `${origin}/fail` },
            normalize: [mask("detail", "url_error_detail")],
          },
        ),
        rotatedPair.access_token,
      );
    },
  );

  const sessionCreateResponse = await send(
    mutationEntry(
      "mutation-session-create",
      "create session with idempotency key",
      "POST",
      `/v1/vaults/${vaultId}/sessions`,
      "POST /vaults/{vault_id}/sessions",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/sessions",
        body: {
          idempotency_key: "parity-session-key",
          exchange: {
            id: "ex-parity-session",
            query: "Parity session question",
            thinking: [],
            answer: "Parity session answer.",
          },
          origin: null,
        },
        normalize: [mask("id", "session_id"), mask("path", "session_path")],
      },
    ),
    rotatedPair.access_token,
  );
  const sessionId = parseCreatedId(sessionCreateResponse.body, "session id");
  await send(
    mutationEntry(
      "mutation-session-create-replay",
      "idempotent session create replay",
      "POST",
      `/v1/vaults/${vaultId}/sessions`,
      "POST /vaults/{vault_id}/sessions",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/sessions",
        body: {
          idempotency_key: "parity-session-key",
          exchange: {
            id: "ex-parity-session",
            query: "Parity session question",
            thinking: [],
            answer: "Parity session answer.",
          },
          origin: null,
        },
        normalize: [mask("id", "session_id"), mask("path", "session_path")],
      },
    ),
    rotatedPair.access_token,
  );
  await send(
    mutationEntry(
      "mutation-session-btw",
      "append BTW with context",
      "PATCH",
      `/v1/vaults/${vaultId}/sessions/${sessionId}/btw`,
      "PATCH /vaults/{vault_id}/sessions/{session_id}/btw",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/sessions/{session_id}/btw",
        body: {
          quote: "Parity quote",
          blockOffset: 1,
          context: "Parity context passage",
          exchangeId: "ex-parity-session",
          exchanges: [
            {
              query: "Why this quote?",
              thinking: [],
              answer: "Because it is specific.",
            },
          ],
        },
        normalize: [mask("path", "session_path")],
      },
    ),
    editorToken,
  );
  await send(
    mutationEntry(
      "mutation-session-read-after-btw",
      "read BTW context replay",
      "GET",
      `/v1/vaults/${vaultId}/sessions/${sessionId}`,
      "GET /vaults/{vault_id}/sessions/{session_id}",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/sessions/{session_id}",
        normalize: [
          mask("id", "session_id"),
          mask("events.*.id", "session_id"),
          mask("events.*.user_id", "user_id"),
          mask("events.*.ts", "event_ts"),
          {
            kind: "mask",
            path: "events.*.context",
            label: "btw_context",
            backend: "python",
          },
          {
            kind: "mask",
            path: "events.*.context",
            label: "btw_context",
            backend: "typescript",
          },
        ],
        decision: "M3_D3_BTW_CONTEXT",
      },
    ),
    editorToken,
  );
  await send(
    mutationEntry(
      "mutation-session-append-exchange",
      "append follow-up exchange",
      "PATCH",
      `/v1/vaults/${vaultId}/sessions/${sessionId}`,
      "PATCH /vaults/{vault_id}/sessions/{session_id}",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/sessions/{session_id}",
        body: {
          id: "ex-parity-follow",
          query: "Parity follow-up question",
          thinking: [],
          answer: "Parity follow-up answer.",
        },
        normalize: [mask("path", "session_path")],
      },
    ),
    memberToken,
  );
  await send(
    mutationEntry(
      "mutation-session-promote-owner",
      "promote exchange as owner",
      "POST",
      `/v1/vaults/${vaultId}/sessions/${sessionId}/exchanges/ex-parity-session/promote`,
      "POST /vaults/{vault_id}/sessions/{session_id}/exchanges/{exchange_id}/promote",
      {
        pathTemplate:
          "/v1/vaults/{created_vault_id}/sessions/{session_id}/exchanges/{exchange_id}/promote",
        decision: "M3_D2_TITLE_NULL",
      },
    ),
    rotatedPair.access_token,
  );
  await send(
    mutationEntry(
      "mutation-session-promote-editor",
      "promote exchange as editor proposal",
      "POST",
      `/v1/vaults/${vaultId}/sessions/${sessionId}/exchanges/ex-parity-follow/promote`,
      "POST /vaults/{vault_id}/sessions/{session_id}/exchanges/{exchange_id}/promote",
      {
        pathTemplate:
          "/v1/vaults/{created_vault_id}/sessions/{session_id}/exchanges/{exchange_id}/promote",
        normalize: [mask("proposal_id", "proposal_id")],
      },
    ),
    editorToken,
  );
  await send(
    mutationEntry(
      "mutation-session-promote-missing-session",
      "promote missing session",
      "POST",
      `/v1/vaults/${vaultId}/sessions/s-missing/exchanges/ex-no-session/promote`,
      "POST /vaults/{vault_id}/sessions/{session_id}/exchanges/{exchange_id}/promote",
      {
        pathTemplate:
          "/v1/vaults/{created_vault_id}/sessions/{missing_session_id}/exchanges/{exchange_id}/promote",
        decision: "M3_D5_PROMOTE_MISSING_SESSION",
      },
    ),
    rotatedPair.access_token,
  );

  await send(
    mutationEntry(
      "mutation-member-update",
      "change member role",
      "PUT",
      `/v1/vaults/${vaultId}/members/${memberUserId}`,
      "PUT /vaults/{vault_id}/members/{user_id}",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/members/{member_user_id}",
        body: { role: "editor" },
        normalize: [mask("user_id", "user_id")],
      },
    ),
    rotatedPair.access_token,
  );

  await send(
    mutationEntry(
      "mutation-member-remove",
      "remove member",
      "DELETE",
      `/v1/vaults/${vaultId}/members/${memberUserId}`,
      "DELETE /vaults/{vault_id}/members/{user_id}",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/members/{member_user_id}",
        ignoreContentType: true,
      },
    ),
    rotatedPair.access_token,
  );

  const proposalId = await seedNormalProposal(databaseUrl, dataDir, vaultId, editorUserId);
  await send(
    mutationEntry(
      "mutation-proposals-list",
      "list pending proposals",
      "GET",
      `/v1/vaults/${vaultId}/proposals?status=pending`,
      "GET /vaults/{vault_id}/proposals",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/proposals?status=pending",
        normalize: [
          mask("items.*.id", "proposal_id"),
          mask("items.*.vault_id", "vault_id"),
          mask("items.*.created_at", "created_at"),
        ],
      },
    ),
    editorToken,
  );
  await send(
    mutationEntry(
      "mutation-proposals-get",
      "get proposal",
      "GET",
      `/v1/vaults/${vaultId}/proposals/${proposalId}`,
      "GET /vaults/{vault_id}/proposals/{proposal_id}",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/proposals/{proposal_id}",
        normalize: [
          mask("id", "proposal_id"),
          mask("vault_id", "vault_id"),
          mask("user_id", "user_id"),
          mask("created_at", "created_at"),
          mask("document_id", "document_id"),
        ],
      },
    ),
    editorToken,
  );
  await send(
    mutationEntry(
      "mutation-proposals-review-approve",
      "approve normal proposal",
      "PATCH",
      `/v1/vaults/${vaultId}/proposals/${proposalId}`,
      "PATCH /vaults/{vault_id}/proposals/{proposal_id}",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/proposals/{proposal_id}",
        body: { status: "approved" },
        normalize: [
          mask("id", "proposal_id"),
          mask("vault_id", "vault_id"),
          mask("user_id", "user_id"),
          mask("created_at", "created_at"),
          mask("document_id", "document_id"),
        ],
      },
    ),
    rotatedPair.access_token,
  );

  const deletePathB = await seedSourceDeletionFixture(databaseUrl, dataDir, vaultId);
  await send(
    mutationEntry(
      "mutation-source-delete-direct",
      "owner direct source delete",
      "DELETE",
      `/v1/vaults/${vaultId}/raw/sources/${encodePath(deletePathB)}`,
      "DELETE /vaults/{vault_id}/raw/sources/{path}",
      {
        pathTemplate: "/v1/vaults/{created_vault_id}/raw/sources/{source_path}",
        ignoreContentType: true,
      },
    ),
    rotatedPair.access_token,
  );

  const transferVaultResponse = await send(
    mutationEntry(
      "mutation-vault-create-for-transfer",
      "create transfer vault",
      "POST",
      "/v1/vaults",
      "POST /vaults",
      {
        body: { name: "Transfer Project" },
        normalize: [
          mask("id", "vault_id"),
          mask("owner_id", "owner_id"),
          mask("created_at", "created_at"),
        ],
      },
    ),
    rotatedPair.access_token,
  );
  const transferVaultId = parseCreatedId(transferVaultResponse.body, "transfer vault id");
  const transferInvite = await send(
    mutationEntry(
      "mutation-member-invite-transfer-target",
      "invite transfer target",
      "POST",
      `/v1/vaults/${transferVaultId}/members`,
      "POST /vaults/{vault_id}/members",
      {
        pathTemplate: "/v1/vaults/{transfer_vault_id}/members",
        body: { email: "parity-transfer@example.com", role: "editor" },
        normalize: [mask("user_id", "user_id")],
      },
    ),
    rotatedPair.access_token,
  );
  const transferUserId = asString(asRecord(transferInvite.body).user_id, "transfer user id");
  await send(
    mutationEntry(
      "mutation-vault-transfer-ownership",
      "transfer vault ownership",
      "POST",
      `/v1/vaults/${transferVaultId}/transfer-ownership`,
      "POST /vaults/{vault_id}/transfer-ownership",
      {
        pathTemplate: "/v1/vaults/{transfer_vault_id}/transfer-ownership",
        body: { new_owner_user_id: transferUserId },
        ignoreContentType: true,
      },
    ),
    rotatedPair.access_token,
  );

  const deleteVaultResponse = await send(
    mutationEntry(
      "mutation-vault-create-for-delete",
      "create delete vault",
      "POST",
      "/v1/vaults",
      "POST /vaults",
      {
        body: { name: "Delete Project" },
        normalize: [
          mask("id", "vault_id"),
          mask("owner_id", "owner_id"),
          mask("created_at", "created_at"),
        ],
      },
    ),
    rotatedPair.access_token,
  );
  const deleteVaultId = parseCreatedId(deleteVaultResponse.body, "delete vault id");
  await send(
    mutationEntry(
      "mutation-vault-delete",
      "delete vault",
      "DELETE",
      `/v1/vaults/${deleteVaultId}`,
      "DELETE /vaults/{vault_id}",
      { pathTemplate: "/v1/vaults/{delete_vault_id}", ignoreContentType: true },
    ),
    rotatedPair.access_token,
  );

  await send(
    mutationEntry(
      "mutation-delete-me-invalid",
      "delete me invalid confirm",
      "DELETE",
      "/v1/auth/me",
      "DELETE /auth/me",
      {
        body: { confirm: "delete" },
        decision: "D6",
      },
    ),
    rotatedPair.access_token,
  );
  await send(
    mutationEntry(
      "mutation-delete-me",
      "delete me cascade",
      "DELETE",
      "/v1/auth/me",
      "DELETE /auth/me",
      {
        body: { confirm: "DELETE" },
        ignoreContentType: true,
      },
    ),
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

const validateCoverage = (
  requests: readonly RequestReport[],
  decisionHits: ReadonlyMap<DecisionId, number>,
) => {
  const covered = new Set(requests.map((request) => request.entry.coverage));
  const excluded = new Set(endpointExclusions.map((item) => item.split(" -- ", 1)[0]));
  const missing = requiredContractEndpoints.filter(
    (endpoint) => !covered.has(endpoint) && !excluded.has(endpoint),
  );
  if (missing.length > 0) {
    throw new Error(`missing manifest coverage: ${missing.join(", ")}`);
  }
  const missingDecisions = decisionIds.filter(
    (decision) => (decisionHits.get(decision) ?? 0) === 0,
  );
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
      ["--experimental-strip-types", "packages/parity/src/typescript-server.ts"],
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
    await assertNoTypescriptReconciliation(config.databaseUrl);
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
    await assertNoTypescriptReconciliation(config.databaseUrl);

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
