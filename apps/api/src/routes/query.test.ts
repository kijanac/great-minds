import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, test, vi, afterEach } from "vitest";
import { LlmClient } from "@great-minds/core/llm";
import { openRouterLlmClient } from "@great-minds/core/openrouter";
import { Db, type BackendDb } from "@great-minds/db/context";
import { createApp } from "../app.js";
import type { ApiConfig } from "../context.js";
import type { ApiRuntime } from "../runtime.js";

const userId = "11111111-1111-4111-8111-111111111111";
const vaultId = "22222222-2222-4222-8222-222222222222";
const apiKeyId = "33333333-3333-4333-8333-333333333333";
const openRouterProvider = {
  kind: "openrouter",
  apiKey: "test",
  baseUrl: "https://openrouter.test/api/v1",
} satisfies ApiConfig["openAiProvider"];

const user = { id: userId, email: "test@greatminds.local", createdAt: new Date("2026-01-01T00:00:00Z") };
const vault = {
  id: vaultId,
  ownerId: userId,
  name: "Test Vault",
  thematicHint: "",
  kinds: ["person", "event", "organization", "concept"],
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

const baseConfig: ApiConfig = {
  auth: {
    jwtSecret: "test-secret-test-secret-test-secret-test-secret",
    jwtAccessExpiryMinutes: 15,
    jwtRefreshExpiryDays: 30,
    authCodeExpiryMinutes: 10,
  },
  authCodeDelivery: { kind: "console" },
  openAiProvider: { kind: "disabled" },
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("POST /v1/vaults/:id/query", () => {
  test("returns 404 when the authenticated user cannot access the vault", async () => {
    const app = createTestApp({ workspace: null });

    const response = await postQuery(app);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { message: "Vault not found" } });
  });

  test("returns 502 when the LLM provider is not configured", async () => {
    const app = createTestApp({ workspace: { user, vault } });

    const response = await postQuery(app);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { message: "LLM provider is not configured" } });
  });

  test("returns 502 when the LLM provider is unavailable", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));
    const app = createTestApp({ workspace: { user, vault } }, { ...baseConfig, openAiProvider: openRouterProvider });

    const responsePromise = postQuery(app);
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { message: "LLM provider is unavailable" } });
  });

  test("returns an answer from the provider chat completion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ choices: [{ message: { content: "The answer." } }] }))),
    );
    const app = createTestApp({ workspace: { user, vault } }, { ...baseConfig, openAiProvider: openRouterProvider });

    const response = await postQuery(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answer: "The answer." });
  });

  test("returns an answer after a transient provider failure", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "Recovered." } }] }));
    vi.stubGlobal("fetch", fetch);
    const app = createTestApp({ workspace: { user, vault } }, { ...baseConfig, openAiProvider: openRouterProvider });

    const responsePromise = postQuery(app);
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answer: "Recovered." });
  });

  test("returns an answer after provider rate limiting", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "1" } }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "After retry." } }] }));
    vi.stubGlobal("fetch", fetch);
    const app = createTestApp({ workspace: { user, vault } }, { ...baseConfig, openAiProvider: openRouterProvider });

    const responsePromise = postQuery(app);
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answer: "After retry." });
  });

  test("does not retry provider request rejections", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 400 })));
    vi.stubGlobal("fetch", fetch);
    const app = createTestApp({ workspace: { user, vault } }, { ...baseConfig, openAiProvider: openRouterProvider });

    const response = await postQuery(app);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { message: "LLM provider rejected the request" } });
  });

  test("rejects API keys without query scope", async () => {
    const app = createTestApp({ workspace: { user, vault }, apiKeyScopes: ["vaults:read"] });

    const response = await postQuery(app);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { message: "Insufficient API key scope" } });
  });
});

function postQuery(app: ReturnType<typeof createApp>) {
  return app.request(`/v1/vaults/${vaultId}/query`, {
    method: "POST",
    headers: {
      Authorization: "Bearer test-api-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ question: "What matters?", model: "test/model" }),
  });
}

type FakeRuntimeOptions = Parameters<typeof fakeDb>[0] & {
  openAiProvider?: ApiConfig["openAiProvider"];
};

function createTestApp(options: FakeRuntimeOptions = {}, config = baseConfig) {
  return createApp(fakeRuntime({ ...options, openAiProvider: config.openAiProvider }), config);
}

function fakeRuntime({ openAiProvider = { kind: "disabled" }, ...options }: FakeRuntimeOptions = {}): ApiRuntime {
  const layer = Layer.succeed(Db, fakeDb(options)).pipe(
    Layer.merge(Layer.succeed(LlmClient, openRouterLlmClient(openAiProvider))),
  );
  return ManagedRuntime.make(layer) as ApiRuntime;
}

function fakeDb({
  workspace = { user, vault },
  apiKeyScopes = ["query"],
}: {
  workspace?: { user: typeof user; vault: typeof vault } | null;
  apiKeyScopes?: string[];
} = {}): BackendDb {
  return {
    select(selection?: Record<string, unknown>) {
      if (selection && "apiKeyId" in selection) {
        return chain([{ apiKeyId, scopes: apiKeyScopes, user }]);
      }

      if (selection && "vault" in selection) {
        return chain(workspace ? [workspace] : []);
      }

      return chain([]);
    },
  } as unknown as BackendDb;
}

function chain<T>(rows: T[]) {
  const query = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    limit: () => Effect.succeed(rows),
  };
  return query;
}
