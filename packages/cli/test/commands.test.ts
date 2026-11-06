import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Uuid } from "@great-minds/domain";
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ask, login, logout, update } from "../src/commands.ts";
import { CliFetch } from "../src/connection.ts";
import { Credentials, CredentialsLive } from "../src/credentials.ts";
import { Output } from "../src/output.ts";

const apiUrl = "http://test.local/v1";
const uuid = Schema.decodeUnknownSync(Uuid);
const vaultId = uuid("70000000-0000-4000-8000-000000000001");
const keyId = uuid("70000000-0000-4000-8000-000000000002");
const oldKeyId = uuid("70000000-0000-4000-8000-000000000003");
const runId = "70000000-0000-4000-8000-000000000004";
const replyId = "70000000-0000-4000-8000-000000000005";
const now = "2026-11-06T00:00:00.000Z";

type Recorded = {
  readonly method: string;
  readonly path: string;
  readonly auth: string | null;
  readonly body: string;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const events = (snapshots: readonly unknown[]) =>
  new Response(
    [
      "event: connected\ndata: {}\n\n",
      ...snapshots.map((snapshot) => `data: ${JSON.stringify(snapshot)}\n\n`),
      "event: done\ndata: \n\n",
    ].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

let directory = "";
let requests: Recorded[] = [];
let lines: string[] = [];
let notes: string[] = [];
let route: (request: Recorded) => Response = () => json(404, {});

const fakeFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const recorded = {
    method: request.method,
    path: new URL(request.url).pathname,
    auth: request.headers.get("authorization"),
    body: await request.text(),
  };
  requests.push(recorded);
  return route(recorded);
};

const layer = () =>
  Layer.mergeAll(
    CredentialsLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ConfigProvider.layer(ConfigProvider.fromUnknown({ GM_CONFIG_DIR: directory })),
        ),
      ),
    ),
    Layer.succeed(CliFetch, fakeFetch),
    Layer.succeed(Output, {
      write: (text: string) => Effect.sync(() => void lines.push(text)),
      line: (text: string) => Effect.sync(() => void lines.push(text)),
      note: (text: string) => Effect.sync(() => void notes.push(text)),
    }),
  );

const run = <A, E>(effect: Effect.Effect<A, E, Credentials | CliFetch | Output>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer())));

const signedIn = (vault: Uuid | null) =>
  run(
    Effect.flatMap(Credentials, (credentials) =>
      credentials.save({
        api_url: apiUrl,
        api_key: "gm_saved",
        api_key_id: oldKeyId,
        vault_id: vault,
      }),
    ),
  );

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gm-cli-"));
  requests = [];
  lines = [];
  notes = [];
});

afterEach(() => rm(directory, { recursive: true, force: true }));

describe("gm login", () => {
  it("signs in with the emailed code, saves only its own API key owner-readable, and revokes the key it replaces", async () => {
    await signedIn(vaultId);
    route = (request) => {
      if (request.path === "/v1/auth/request-code") return new Response(null, { status: 204 });
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
        return new Response(null, { status: 204 });
      return json(404, {});
    };
    await run(
      login({
        email: "reader@example.com",
        url: Option.some(apiUrl),
        readCode: Effect.succeed(" 123456 "),
      }),
    );

    expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({
      email: "reader@example.com",
      code: "123456",
    });
    expect(requests[2]?.auth).toBe("Bearer access-1");
    expect(requests[3]).toMatchObject({ method: "DELETE", auth: "Bearer access-1" });
    const file = join(directory, "credentials.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      api_url: apiUrl,
      api_key: "gm_new",
      api_key_id: keyId,
      vault_id: vaultId,
    });
    expect(await readFile(file, "utf8")).not.toContain("access-1");
  });

  it("logout revokes the saved key and forgets it", async () => {
    await signedIn(null);
    route = () => new Response(null, { status: 204 });
    await run(logout);
    expect(requests).toEqual([
      {
        method: "DELETE",
        path: `/v1/auth/api-keys/${oldKeyId}`,
        auth: "Bearer gm_saved",
        body: "",
      },
    ]);
    await expect(stat(join(directory, "credentials.json"))).rejects.toThrow();
  });
});

describe("gm ask", () => {
  it("streams the answer with the saved key, shows the steps, and lists the sources it read", async () => {
    await signedIn(vaultId);
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
    route = (request) => {
      if (request.method === "POST" && request.path === `/v1/vaults/${vaultId}/replies`)
        return json(202, { reply_id: replyId, session_id: "session-1" });
      if (request.path === `/v1/vaults/${vaultId}/replies/${replyId}/stream`)
        return events([
          reply("running", "", [source("search", "liquidationism", null)]),
          reply(
            "completed",
            "Liquidationism was a tendency ([Liquidationism](wiki/liquidationism.md)).",
            [
              source("search", "liquidationism", null),
              source("article", "wiki/liquidationism.md", "Liquidationism"),
            ],
          ),
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
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      question: "What was liquidationism?",
      session: { kind: "new" },
    });
    expect(notes[0]).toBe('  searching for "liquidationism"');
    expect(lines).toEqual([
      "Liquidationism was a tendency ([Liquidationism](wiki/liquidationism.md)).",
      "",
      "Sources:",
      "  [1] Liquidationism  wiki/liquidationism.md",
    ]);
  });

  it("asks for a vault when the account has several and none is chosen", async () => {
    await signedIn(null);
    route = () =>
      json(200, {
        items: [
          { id: vaultId, name: "One", owner_id: vaultId, created_at: now },
          { id: keyId, name: "Two", owner_id: vaultId, created_at: now },
        ],
        pagination: { total: 2, limit: 50, offset: 0 },
        roles: {},
      });
    const failure = await run(
      ask({
        question: "Anything?",
        session: Option.none(),
        vault: Option.none(),
        json: false,
      }).pipe(Effect.flip),
    );
    expect(failure.message).toBe("choose a vault: gm vault use <name>, or pass --vault");
  });
});

describe("gm update", () => {
  it("starts an Update, follows its stages, and lists what changed including merges", async () => {
    await signedIn(vaultId);
    const stage = (key: string, title: string, status: string) => ({
      key,
      label: title,
      title,
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
    route = (request) => {
      if (request.method === "POST" && request.path === `/v1/vaults/${vaultId}/compile`)
        return json(202, {
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
      if (request.path === `/v1/vaults/${vaultId}/jobs/${runId}/stream`)
        return events([
          snapshot("running", [stage("writing", "Writing articles", "running")], null),
          snapshot("completed", [stage("writing", "Writing articles", "completed")], {
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

    expect(notes).toEqual([
      `Update ${runId} (gm run ${runId} to follow it again)`,
      "… Writing articles",
      "✓ Writing articles",
    ]);
    expect(lines).toEqual([
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
