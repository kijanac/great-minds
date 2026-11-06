import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { citationsOf, Uuid } from "@great-minds/domain";
import {
  Cause,
  ConfigProvider,
  Console,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  add,
  ask,
  callApi,
  listRuns,
  login,
  logout,
  readDocument,
  update,
} from "../src/commands.ts";
import { CliFetch } from "../src/connection.ts";
import { Credentials, CredentialsLive } from "../src/credentials.ts";

const apiUrl = "https://test.local/v1";
const otherUrl = "https://other.local/v1";
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
const vaultDetail = () =>
  json(200, {
    id: vaultId,
    name: "One",
    owner_id: vaultId,
    created_at: now,
    role: "owner",
    member_count: 1,
    article_count: 0,
  });
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
    NodeServices.layer,
  );

const exit = <A, E>(
  effect: Effect.Effect<A, E, Credentials | CliFetch | FileSystem.FileSystem>,
  env: Record<string, string> = {},
) =>
  Effect.runPromise(
    Effect.exit(effect).pipe(
      Effect.provideService(Console.Console, capture),
      Effect.provide(layer(env)),
    ),
  );
const run = async <A, E>(
  effect: Effect.Effect<A, E, Credentials | CliFetch | FileSystem.FileSystem>,
  env: Record<string, string> = {},
) => {
  const result = await exit(effect, env);
  if (Exit.isFailure(result)) throw new Error(`expected success, got ${String(result.cause)}`);
  return result.value;
};
const failureTag = async <A, E>(
  effect: Effect.Effect<A, E, Credentials | CliFetch | FileSystem.FileSystem>,
  env: Record<string, string> = {},
) => {
  const result = await exit(effect, env);
  if (Exit.isSuccess(result)) return "success";
  const error = Cause.findErrorOption(result.cause);
  return Option.isSome(error) &&
    typeof error.value === "object" &&
    error.value !== null &&
    "_tag" in error.value
    ? error.value._tag
    : "defect";
};

const credentialsFile = () => join(directory, "credentials.json");
const saveCredentials = (saved: {
  readonly api_url: string;
  readonly api_key: string;
  readonly api_key_id: Uuid | null;
  readonly vault_id: Uuid | null;
}) => run(Effect.flatMap(Credentials, (credentials) => credentials.save(saved)));
const savedFile = async () => JSON.parse(await readFile(credentialsFile(), "utf8"));
let polls = 0;
const signInRoutes =
  (onDeleteOld: () => Response, approval: "approved" | "denied" | "expired" = "approved") =>
  (request: Recorded) => {
    if (request.path === "/v1/auth/cli/start")
      return json(200, {
        device_code: "device-1",
        user_code: "WDJB-MJHT",
        verification_url: "https://example.test/cli",
        verification_url_complete: "https://example.test/cli?code=WDJB-MJHT",
        interval_seconds: 0,
        expires_at: now,
      });
    if (request.path === "/v1/auth/cli/token") {
      polls += 1;
      if (polls < 2) return json(200, { status: "pending" });
      if (approval !== "approved") return json(200, { status: approval });
      return json(200, {
        status: "approved",
        email: "reader@example.com",
        api_key: {
          id: keyId,
          label: "gm CLI (test)",
          created_at: now,
          revoked: false,
          vault_ids: null,
          can_ask: true,
          can_change: true,
          expires_at: null,
          last_used_at: null,
          raw_key: "gm_new",
        },
      });
    }
    if (request.method === "DELETE" && request.path === `/v1/auth/api-keys/${oldKeyId}`)
      return onDeleteOld();
    return json(404, {});
  };
const signIn = (url: string) => login({ url: Option.some(url) });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gm-cli-"));
  requests = [];
  stdout = [];
  stderr = [];
  route = () => json(404, {});
  polls = 0;
});

afterEach(() => rm(directory, { recursive: true, force: true }));

describe("gm login", () => {
  it("saves only its own key, owner-readable, keeps the vault and revokes the key it replaces", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_old",
      api_key_id: oldKeyId,
      vault_id: vaultId,
    });
    route = signInRoutes(noContent);
    await run(signIn(apiUrl));

    expect(requests.map((request) => request.path)).toEqual([
      "/v1/auth/cli/start",
      "/v1/auth/cli/token",
      "/v1/auth/cli/token",
      `/v1/auth/api-keys/${oldKeyId}`,
    ]);
    expect(requests[3]).toMatchObject({ method: "DELETE", auth: "Bearer gm_new" });
    expect(stderr.join("\n")).toContain("https://example.test/cli?code=WDJB-MJHT");
    expect((await stat(credentialsFile())).mode & 0o777).toBe(0o600);
    expect(await savedFile()).toEqual({
      api_url: apiUrl,
      api_key: "gm_new",
      api_key_id: keyId,
      vault_id: vaultId,
    });
  });

  it("stops with a named error when the browser cancels or the code expires", async () => {
    route = signInRoutes(noContent, "denied");
    expect(await failureTag(signIn(apiUrl))).toBe("LoginCancelled");
    polls = 0;
    route = signInRoutes(noContent, "expired");
    expect(await failureTag(signIn(apiUrl))).toBe("LoginExpired");
    await expect(stat(credentialsFile())).rejects.toThrow();
  });

  it("still signs in when the old key cannot be revoked, and names the key left to revoke", async () => {
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
    expect(requests).toMatchObject([
      { method: "DELETE", path: `/v1/auth/api-keys/${oldKeyId}`, auth: "Bearer gm_saved" },
    ]);
    await expect(stat(credentialsFile())).rejects.toThrow();
  });

  it("keeps the key and fails when revoking fails, so it can be retried", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_saved",
      api_key_id: oldKeyId,
      vault_id: null,
    });
    route = () => json(503, { _tag: "ServiceUnavailable", detail: "busy" });
    expect(await failureTag(logout())).toBe("KeyNotRevoked");
    expect(await savedFile()).toMatchObject({ api_key_id: oldKeyId });
  });
});

describe("credentials", () => {
  it("an unreadable credentials file blocks neither login nor logout", async () => {
    await writeFile(credentialsFile(), "{broken", { mode: 0o600 });
    await run(logout());
    await expect(stat(credentialsFile())).rejects.toThrow();
    await writeFile(credentialsFile(), "{broken", { mode: 0o600 });
    route = signInRoutes(noContent);
    await run(signIn(apiUrl));
    expect(await savedFile()).toMatchObject({ api_key: "gm_new" });
  });

  it("a saved key and vault stay with their own server", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_saved",
      api_key_id: oldKeyId,
      vault_id: vaultId,
    });
    expect(
      await failureTag(listRuns({ vault: Option.none(), limit: 20, json: false }), {
        GM_API_URL: otherUrl,
      }),
    ).toBe("NotSignedIn");
    expect(requests).toEqual([]);

    route = signInRoutes(noContent);
    await run(signIn(otherUrl));
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(await savedFile()).toMatchObject({ api_url: otherUrl, vault_id: null });
  });

  it("a GM_API_KEY never borrows the saved default vault", async () => {
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
    citations: citationsOf(answer),
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
      if (request.path === `/v1/vaults/${vaultId}`) return vaultDetail();
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
  const accepted = (status = 202) =>
    json(status, {
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
      if (request.path === `/v1/vaults/${vaultId}`) return vaultDetail();
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
  it("gm add uploads only new supported files from a folder, then follows the run", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_saved",
      api_key_id: oldKeyId,
      vault_id: vaultId,
    });
    const folder = join(directory, "notes");
    await mkdir(join(folder, "sub"), { recursive: true });
    await mkdir(join(folder, ".obsidian"), { recursive: true });
    await writeFile(join(folder, "new.md"), "# New\n");
    await writeFile(join(folder, "sub", "known.md"), "# Known\n");
    await writeFile(join(folder, "photo.png"), "not text");
    await writeFile(join(folder, ".obsidian", "workspace.json"), "{}");
    const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");
    const newHash = hashOf("# New\n");
    route = (request) => {
      if (request.path === `/v1/vaults/${vaultId}`) return vaultDetail();
      if (request.path === `/v1/vaults/${vaultId}/file-ingests/check-dupes`)
        return json(200, { existing: [hashOf("# Known\n")] });
      if (request.path === `/v1/vaults/${vaultId}/file-ingests`) {
        const { batch_id, files } = JSON.parse(request.body);
        return json(201, {
          id: batch_id,
          vault_id: vaultId,
          created_by: vaultId,
          status: "uploading",
          error: null,
          expires_at: now,
          files: files.map((file: { readonly name: string; readonly hash: string }) => ({
            ...file,
            size: 6,
            mimetype: "",
            status: "pending",
            error: null,
          })),
          targets: files.map((file: { readonly hash: string }) => ({
            hash: file.hash,
            transport: "api",
          })),
        });
      }
      if (request.path.endsWith(`/files/${newHash}`) || request.path.endsWith("/complete"))
        return noContent();
      if (request.path.endsWith("/commit")) return accepted(200);
      if (request.path === `/v1/vaults/${vaultId}/jobs/${runId}/stream`)
        return events([snapshot("completed", [stage("completed")], null)]);
      return json(404, {});
    };
    await run(add({ paths: [folder], vault: Option.none(), json: false }));
    const created = requests.find((request) => request.path.endsWith("/file-ingests"));
    expect(JSON.parse(created?.body ?? "{}").files).toEqual([
      { name: "new.md", size: 6, hash: newHash, mimetype: "" },
    ]);
    expect(
      requests.map((request) => request.path).filter((path) => path.includes("/files/")),
    ).toHaveLength(2);
    expect(requests.some((request) => request.path.endsWith("/commit"))).toBe(true);
    expect(stdout).toEqual(["Update finished."]);
  });
});

describe("reading", () => {
  it("gm read prints a document's text and says when it is archived", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_saved",
      api_key_id: oldKeyId,
      vault_id: vaultId,
    });
    route = (request) => {
      if (request.path === `/v1/vaults/${vaultId}`) return vaultDetail();
      if (request.path === `/v1/vaults/${vaultId}/doc`)
        return json(200, {
          article: {
            kind: "wiki",
            id: vaultId,
            vault_id: vaultId,
            topic_id: vaultId,
            file_path: "archive/x/old.md",
            body_hash: "hash",
            title: "Old",
            precis: "",
            tags: [],
            created_at: now,
            updated_at: now,
            slug: "old",
          },
          body: "# Old\n\nText.",
          archived: true,
          superseded_by: "wiki/new.md",
        });
      return json(404, {});
    };
    await run(readDocument({ path: "archive/x/old.md", vault: Option.none(), json: false }));
    expect(stdout).toEqual(["# Old\n\nText."]);
    expect(stderr).toEqual(["This article is archived; see wiki/new.md."]);
  });

  it("gm api sends the method, path and body with the saved key, and fails on an error status", async () => {
    await saveCredentials({
      api_url: apiUrl,
      api_key: "gm_saved",
      api_key_id: oldKeyId,
      vault_id: null,
    });
    route = (request) =>
      request.path === "/v1/vaults" ? json(200, { ok: true }) : json(403, { detail: "no" });
    await run(callApi({ method: "post", path: "/vaults", data: Option.some('{"name":"x"}') }));
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/vaults",
      auth: "Bearer gm_saved",
      body: '{"name":"x"}',
    });
    expect(stdout).toEqual(['{"ok":true}']);
    expect(
      await failureTag(callApi({ method: "get", path: "vaults/x", data: Option.none() })),
    ).toBe("ApiCallFailed");
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

  it("exits 0 for help, 1 with a one-line error for a failure", () => {
    expect(gm([]).status).toBe(0);
    expect(gm(["nonsense"]).status).toBe(1);
    const failed = gm(["runs"]);
    expect(failed.status).toBe(1);
    expect(failed.stderr.trim()).toBe("gm: not signed in: run gm login, or set GM_API_KEY");
  });
});

describe("gm mcp", { timeout: 30_000 }, () => {
  it("serves the vault's tools over stdio, with typed results and the API's error detail", async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "", "http://localhost");
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (url.pathname === `/v1/vaults/${vaultId}`)
        return send(200, {
          id: vaultId,
          name: "One",
          owner_id: vaultId,
          created_at: now,
          role: "owner",
          member_count: 1,
          article_count: 0,
        });
      if (url.pathname === `/v1/vaults/${vaultId}/search`)
        return send(200, [
          {
            path: "wiki/nep.md",
            chunk_index: 0,
            heading: "",
            text: url.searchParams.get("q"),
            score: 1,
          },
        ]);
      return send(404, { _tag: "NotFound", detail: "No such document" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const child = spawn(
      process.execPath,
      [new URL("../src/main.ts", import.meta.url).pathname, "mcp"],
      {
        env: {
          ...process.env,
          GM_CONFIG_DIR: directory,
          GM_API_KEY: "gm_test",
          GM_API_URL: `http://localhost:${port}/v1`,
          GM_VAULT: vaultId,
        },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const replies = new Map<number, Record<string, unknown>>();
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const message = JSON.parse(line);
        if (typeof message.id === "number") replies.set(message.id, message);
      }
    });
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const reply = async (id: number) => {
      for (let wait = 0; wait < 200 && !replies.has(id); wait += 1)
        await new Promise((resolve) => setTimeout(resolve, 50));
      return replies.get(id)?.result as Record<string, unknown>;
    };
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      });
      await reply(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const tools = (await reply(2)).tools as readonly { name: string; outputSchema?: unknown }[];
      expect(tools.map((tool) => tool.name)).toEqual([
        "search_vault",
        "read_document",
        "list_articles",
        "list_sessions",
        "read_session",
        "ask",
      ]);
      expect(tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_vault", arguments: { query: "the NEP" } },
      });
      expect((await reply(3)).structuredContent).toEqual({
        hits: [{ path: "wiki/nep.md", chunk_index: 0, heading: "", text: "the NEP", score: 1 }],
      });
      send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "read_document", arguments: { path: "wiki/missing.md" } },
      });
      expect(await reply(4)).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "No such document" }],
      });
    } finally {
      child.kill();
      server.close();
    }
  });
});
