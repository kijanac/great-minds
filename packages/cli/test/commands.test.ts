import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Uuid } from "@great-minds/domain";
import { ConfigProvider, Console, Effect, Exit, Layer, Option, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ask, listRuns, login, logout, update } from "../src/commands.ts";
import { CliFetch } from "../src/connection.ts";
import { Credentials, CredentialsLive } from "../src/credentials.ts";

const apiUrl = "http://test.local/v1";
const otherUrl = "http://other.local/v1";
const uuid = Schema.decodeUnknownSync(Uuid);
const vaultId = uuid("70000000-0000-4000-8000-000000000001");
const keyId = uuid("70000000-0000-4000-8000-000000000002");
const oldKeyId = uuid("70000000-0000-4000-8000-000000000003");
const runId = uuid("70000000-0000-4000-8000-000000000004");
const replyId = uuid("70000000-0000-4000-8000-000000000005");
const otherVault = uuid("70000000-0000-4000-8000-000000000006");
const now = "2026-11-06T00:00:00.000Z";

type Recorded = {
  readonly method: string;
  readonly path: string;
  readonly host: string;
  readonly auth: string | null;
  readonly body: string;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noContent = () => new Response(null, { status: 204 });
const events = (snapshots: readonly unknown[]) =>
  new Response(
    [
      "event: connected\ndata: {}\n\n",
      ...snapshots.map((snapshot) => `data: ${JSON.stringify(snapshot)}\n\n`),
      "event: done\ndata: \n\n",
    ].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
const oneVault = () =>
  json(200, {
    items: [{ id: vaultId, name: "One", owner_id: vaultId, created_at: now }],
    pagination: { total: 1, limit: 50, offset: 0 },
    roles: {},
  });

let directory = "";
let requests: Recorded[] = [];
let stdout: string[] = [];
let stderr: string[] = [];
let route: (request: Recorded) => Response = () => json(404, {});

const fakeFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const recorded = {
    method: request.method,
    path: url.pathname,
    host: url.host,
    auth: request.headers.get("authorization"),
    body: await request.text(),
  };
  requests.push(recorded);
  return route(recorded);
};

const capture = Object.assign(Object.create(console), {
  log: (...parts: unknown[]) => void stdout.push(parts.join(" ")),
  error: (...parts: unknown[]) => void stderr.push(parts.join(" ")),
});

const layer = (env: Record<string, string>) =>
  Layer.mergeAll(
    CredentialsLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ConfigProvider.layer(ConfigProvider.fromUnknown({ GM_CONFIG_DIR: directory, ...env })),
        ),
      ),
    ),
    Layer.succeed(CliFetch, fakeFetch),
  );

const exit = <A, E>(
  effect: Effect.Effect<A, E, Credentials | CliFetch>,
  env: Record<string, string> = {},
) =>
  Effect.runPromise(
    Effect.exit(effect).pipe(
      Effect.provideService(Console.Console, capture),
      Effect.provide(layer(env)),
    ),
  );
const run = async <A, E>(
  effect: Effect.Effect<A, E, Credentials | CliFetch>,
  env: Record<string, string> = {},
) => {
  const result = await exit(effect, env);
  if (Exit.isFailure(result)) throw new Error(`expected success, got ${String(result.cause)}`);
  return result.value;
};
const failureTag = async <A, E>(
  effect: Effect.Effect<A, E, Credentials | CliFetch>,
  env: Record<string, string> = {},
) => {
  const result = await exit(effect, env);
  if (Exit.isSuccess(result)) return "success";
  const failure = result.cause.reasons.find((reason) => reason._tag === "Fail");
  const error = failure?._tag === "Fail" ? failure.error : undefined;
  return typeof error === "object" && error !== null && "_tag" in error ? error._tag : "defect";
};

const credentialsFile = () => join(directory, "credentials.json");
const saveCredentials = (saved: {
  readonly api_url: string;
  readonly api_key: string;
  readonly api_key_id: Uuid | null;
  readonly vault_id: Uuid | null;
}) => run(Effect.flatMap(Credentials, (credentials) => credentials.save(saved)));
const savedFile = async () => JSON.parse(await readFile(credentialsFile(), "utf8"));
const signInRoutes = (onDeleteOld: () => Response) => (request: Recorded) => {
  if (request.path === "/v1/auth/request-code") return noContent();
  if (request.path === "/v1/auth/verify-code")
    return json(200, {
      access_token: "access-1",
      refresh_token: "refresh-1",
      token_type: "bearer",
    });
  if (request.method === "POST" && request.path === "/v1/auth/api-keys")
    return json(201, {
      id: keyId,
      label: "gm CLI",
      created_at: now,
      revoked: false,
      raw_key: "gm_new",
    });
  if (request.method === "DELETE" && request.path === `/v1/auth/api-keys/${oldKeyId}`)
    return onDeleteOld();
  return json(404, {});
};
const signIn = (url: string) =>
  login({
    email: "reader@example.com",
    url: Option.some(url),
    readCode: Effect.succeed(" 123456 "),
  });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gm-cli-"));
  requests = [];
  stdout = [];
  stderr = [];
  route = () => json(404, {});
});

afterEach(() => rm(directory, { recursive: true, force: true }));

describe("gm login", () => {
  it("saves only its own key, owner-readable, keeps the vault and revokes the key it replaces on the same server", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_old",
      api_key_id: oldKeyId,
      vault_id: vaultId,
    });
    route = signInRoutes(noContent);
    await run(signIn(apiUrl));

    expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({
      email: "reader@example.com",
      code: "123456",
    });
    expect(requests[2]?.auth).toBe("Bearer access-1");
    expect(requests[3]).toMatchObject({ method: "DELETE", auth: "Bearer access-1" });
    expect((await stat(credentialsFile())).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(await savedFile()).toEqual({
      api_url: apiUrl,
      api_key: "gm_new",
      api_key_id: keyId,
      vault_id: vaultId,
    });
    expect(await readFile(credentialsFile(), "utf8")).not.toContain("access-1");
  });

  it("does not carry a vault or revoke a key from a different server", async () => {
    await saveCredentials({
      api_url: otherUrl,
      api_key: "gm_old",
      api_key_id: oldKeyId,
      vault_id: vaultId,
    });
    route = signInRoutes(noContent);
    await run(signIn(apiUrl));

    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(await savedFile()).toMatchObject({ api_url: apiUrl, vault_id: null });
  });

  it("signs in to GM_API_URL when no --url is given", async () => {
    route = signInRoutes(noContent);
    await run(
      login({ email: "reader@example.com", url: Option.none(), readCode: Effect.succeed("1") }),
      {
        GM_API_URL: apiUrl,
      },
    );
    expect(requests.every((request) => request.host === "test.local")).toBe(true);
    expect(await savedFile()).toMatchObject({ api_url: apiUrl });
  });

  it("still signs in when the old key cannot be revoked, and says so", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_old",
      api_key_id: oldKeyId,
      vault_id: null,
    });
    route = signInRoutes(() => json(503, { _tag: "ServiceUnavailable", detail: "busy" }));
    await run(signIn(apiUrl));

    expect(await savedFile()).toMatchObject({ api_key: "gm_new", api_key_id: keyId });
    expect(stderr.some((line) => line.includes(oldKeyId))).toBe(true);
  });

  it("replaces an unreadable credentials file instead of refusing", async () => {
    await writeFile(credentialsFile(), "{broken", { mode: 0o600 });
    route = signInRoutes(noContent);
    await run(signIn(apiUrl));
    expect(await savedFile()).toMatchObject({ api_key: "gm_new" });
  });
});

describe("gm logout", () => {
  it("revokes the saved key and removes it", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_saved",
      api_key_id: oldKeyId,
      vault_id: null,
    });
    route = noContent;
    await run(logout());
    expect(requests).toEqual([
      {
        method: "DELETE",
        path: `/v1/auth/api-keys/${oldKeyId}`,
        host: "test.local",
        auth: "Bearer gm_saved",
        body: "",
      },
    ]);
    await expect(stat(credentialsFile())).rejects.toThrow();
    expect(stdout).toEqual(["Signed out: the key was revoked and removed from this computer."]);
  });

  it("removes the key even when revoking fails, and does not claim it was revoked", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_saved",
      api_key_id: oldKeyId,
      vault_id: null,
    });
    route = () => json(503, { _tag: "ServiceUnavailable", detail: "busy" });
    await run(logout());
    await expect(stat(credentialsFile())).rejects.toThrow();
    expect(stdout[0]).toContain("could not revoke it");
    expect(stdout[0]).toContain(oldKeyId);
  });

  it("does not claim a revocation when no key id was recorded", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_saved",
      api_key_id: null,
      vault_id: null,
    });
    await run(logout());
    expect(requests).toEqual([]);
    expect(stdout[0]).toContain("revoke it in Settings");
  });

  it("removes an unreadable credentials file", async () => {
    await writeFile(credentialsFile(), "{broken", { mode: 0o600 });
    await run(logout());
    await expect(stat(credentialsFile())).rejects.toThrow();
  });

  it("warns that a key from GM_API_KEY cannot be revoked by logout", async () => {
    await run(logout(), { GM_API_KEY: "gm_env" });
    expect(stderr[0]).toContain("GM_API_KEY is set");
  });
});

describe("credentials", () => {
  it("treats an empty GM_API_KEY as unset", async () => {
    expect(
      await failureTag(listRuns({ vault: Option.none(), limit: 20, json: false }), {
        GM_API_KEY: "",
      }),
    ).toBe("NotSignedIn");
  });

  it("does not send a saved key to a different server named by GM_API_URL", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_saved",
      api_key_id: oldKeyId,
      vault_id: null,
    });
    expect(
      await failureTag(listRuns({ vault: Option.none(), limit: 20, json: false }), {
        GM_API_URL: otherUrl,
      }),
    ).toBe("NotSignedIn");
    expect(requests).toEqual([]);
  });

  it("does not pair a GM_API_KEY with the saved default vault", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_saved",
      api_key_id: oldKeyId,
      vault_id: otherVault,
    });
    route = (request) =>
      request.path === "/v1/vaults"
        ? oneVault()
        : json(200, { items: [], pagination: { total: 0, limit: 20, offset: 0 } });
    await run(listRuns({ vault: Option.none(), limit: 20, json: false }), { GM_API_KEY: "gm_env" });
    expect(requests.map((request) => request.path)).toEqual([
      "/v1/vaults",
      `/v1/vaults/${vaultId}/jobs`,
    ]);
    expect(requests.every((request) => request.auth === "Bearer gm_env")).toBe(true);
  });
});

describe("gm ask", () => {
  const reply = (status: string, answer: string, sources: readonly unknown[]) => ({
    reply_id: replyId,
    session_id: "session-1",
    status,
    answer,
    sources,
    error: null,
    version: 1,
    created_at: now,
    updated_at: now,
  });
  const source = (type: string, label: string, title: string | null) => ({
    label,
    type,
    document_id: null,
    title,
    scope: type === "search" ? "kb" : null,
    path: null,
    thinking: null,
  });

  it("shows the steps on stderr, then prints the answer and the sources it cites", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_saved",
      api_key_id: oldKeyId,
      vault_id: vaultId,
    });
    route = (request) => {
      if (request.path === "/v1/vaults") return oneVault();
      if (request.method === "POST" && request.path === `/v1/vaults/${vaultId}/replies`)
        return json(202, { reply_id: replyId, session_id: "session-1" });
      if (request.path === `/v1/vaults/${vaultId}/replies/${replyId}/stream`)
        return events([
          reply("running", "", [source("search", "liquidationism", null)]),
          reply("completed", "It was a tendency ([Liquidationism](wiki/liquidationism.md)).", [
            source("search", "liquidationism", null),
            source("article", "wiki/liquidationism.md", "Liquidationism"),
          ]),
        ]);
      return json(404, {});
    };
    await run(
      ask({
        question: "What was liquidationism?",
        session: Option.none(),
        vault: Option.none(),
        json: false,
      }),
    );

    expect(requests.every((request) => request.auth === "Bearer gm_saved")).toBe(true);
    expect(JSON.parse(requests[1]?.body ?? "{}")).toMatchObject({
      question: "What was liquidationism?",
      session: { kind: "new", conversation_kind: "session" },
    });
    expect(stderr[0]).toBe('  searching for "liquidationism"');
    expect(stdout).toEqual([
      "It was a tendency ([Liquidationism](wiki/liquidationism.md)).",
      "",
      "Sources:",
      "  [1] Liquidationism  wiki/liquidationism.md",
    ]);
  });

  it("asks which vault to use when there are several and none is chosen", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_saved",
      api_key_id: oldKeyId,
      vault_id: null,
    });
    route = () =>
      json(200, {
        items: [
          { id: vaultId, name: "One", owner_id: vaultId, created_at: now },
          { id: otherVault, name: "Two", owner_id: vaultId, created_at: now },
        ],
        pagination: { total: 2, limit: 50, offset: 0 },
        roles: {},
      });
    expect(
      await failureTag(
        ask({ question: "Anything?", session: Option.none(), vault: Option.none(), json: false }),
      ),
    ).toBe("VaultChoiceNeeded");
  });
});

describe("gm runs", () => {
  it("rejects a --limit outside what the API accepts, before any request", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_saved",
      api_key_id: oldKeyId,
      vault_id: vaultId,
    });
    expect(await failureTag(listRuns({ vault: Option.none(), limit: 0, json: false }))).toBe(
      "LimitOutOfRange",
    );
    expect(await failureTag(listRuns({ vault: Option.none(), limit: 500, json: false }))).toBe(
      "LimitOutOfRange",
    );
    expect(requests).toEqual([]);
  });
});

describe("gm update", () => {
  const stage = (status: string) => ({
    key: "writing",
    label: "Writing",
    title: "Writing articles",
    status,
    steps: [],
    warnings: [],
  });
  const snapshot = (status: string, track: readonly unknown[], outcome: unknown) => ({
    id: runId,
    vault_id: vaultId,
    trigger: "manual",
    job_status: status,
    phase: status === "completed" ? "publish" : "render",
    phase_status: status === "completed" ? "completed" : "progress",
    stages: [],
    warnings: [],
    track,
    outcome,
    created_at: now,
    updated_at: now,
    completed_at: status === "completed" ? now : null,
  });
  const accepted = () =>
    json(202, {
      id: runId,
      vault_id: vaultId,
      trigger: "manual",
      status: "pending",
      current_phase: "",
      phase_status: "",
      stages: [],
      warnings: [],
      error: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
      stream_url: "",
    });

  it("follows the stages and lists what changed, including merges", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_saved",
      api_key_id: oldKeyId,
      vault_id: vaultId,
    });
    route = (request) => {
      if (request.path === "/v1/vaults") return oneVault();
      if (request.method === "POST" && request.path === `/v1/vaults/${vaultId}/compile`)
        return accepted();
      if (request.path === `/v1/vaults/${vaultId}/jobs/${runId}/stream`)
        return events([
          snapshot("running", [stage("running")], null),
          snapshot("completed", [stage("completed")], {
            sources: 0,
            added: [],
            changed: [{ title: "Liquidationism", file_path: "wiki/liquidationism.md" }],
            removed: [
              {
                title: "Liquidationism Debate",
                file_path: "archive/x/liquidationism-debate.md",
                merged_into: { title: "Liquidationism", file_path: "wiki/liquidationism.md" },
              },
            ],
            unchanged: 380,
          }),
        ]);
      return json(404, {});
    };
    await run(update({ vault: Option.none(), json: false }));

    expect(stderr).toEqual([
      `Update ${runId} (gm run ${runId} to follow it again)`,
      "… Writing articles",
      "✓ Writing articles",
    ]);
    expect(stdout).toEqual([
      "1 updated, 1 removed.",
      "",
      "Updated:",
      "  Liquidationism",
      "",
      "Removed:",
      "  Liquidationism Debate  (merged into Liquidationism)",
    ]);
  });
});

describe("the gm command", { timeout: 30_000 }, () => {
  const gm = (args: readonly string[]) =>
    spawnSync(process.execPath, [new URL("../src/main.ts", import.meta.url).pathname, ...args], {
      env: {
        ...process.env,
        GM_CONFIG_DIR: directory,
        GM_API_KEY: "",
        GM_API_URL: "",
        GM_VAULT: "",
      },
      encoding: "utf8",
    });

  it("exits 0 when it only shows help, and 1 for an unknown command", () => {
    expect(gm([]).status).toBe(0);
    expect(gm(["vault"]).status).toBe(0);
    expect(gm(["--help"]).status).toBe(0);
    expect(gm(["nonsense"]).status).toBe(1);
  });

  it("reports its package version", () => {
    expect(gm(["--version"]).stdout).toContain("0.1.0");
  });

  it("prints a one-line error and exits 1 when not signed in", () => {
    const result = gm(["runs"]);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("gm: not signed in: run gm login, or set GM_API_KEY");
  });
});
