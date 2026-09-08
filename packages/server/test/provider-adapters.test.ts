import { ConfigProvider, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { AppConfigLive } from "../src/config.ts";
import { EmbeddingsLive, EmbeddingsService } from "../src/embeddings.ts";
import { CostLookupLive, CostLookupService } from "../src/llm-costs.ts";
import { ParallelSearchLive, ParallelSearchService } from "../src/parallel.ts";

const runtime = ManagedRuntime.make(Layer.mergeAll(EmbeddingsLive, CostLookupLive, ParallelSearchLive).pipe(
  Layer.provide(AppConfigLive),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {
    DATABASE_URL: "postgresql://great-minds.test/great_minds",
    JWT_SECRET: "provider-adapter-test-secret",
    OPENROUTER_API_KEY: "provider-test-key",
    PARALLEL_API_KEY: "search-test-key",
  } }))),
));

afterEach(() => { vi.unstubAllGlobals(); });
afterAll(() => runtime.dispose());

describe("provider adapters", () => {
  it("retries embedding requests twice and preserves vector order", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ data: [
        { index: 1, embedding: [0, 2] },
        { index: 0, embedding: [3, 4] },
      ] }));
    vi.stubGlobal("fetch", fetch);
    const result = await runtime.runPromise(Effect.gen(function* () {
      const embeddings = yield* EmbeddingsService;
      return yield* embeddings.embed(["alpha", "beta"]);
    }));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toEqual([[0.6, 0.8], [0, 1]]);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      input: ["alpha", "beta"], model: "qwen/qwen3-embedding-8b", encoding_format: "base64",
    });
  }, 10_000);

  it("returns null after four generation-status retries", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response("", { status: 404 })));
    vi.stubGlobal("fetch", fetch);
    const result = await runtime.runPromise(Effect.gen(function* () {
      const costs = yield* CostLookupService;
      return yield* costs.lookupGenerationCost("generation");
    }));
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("does not retry non-retryable generation statuses or malformed cost bodies", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ data: { total_cost: "invalid" } }));
    vi.stubGlobal("fetch", fetch);
    const outcomes = await runtime.runPromise(Effect.gen(function* () {
      const costs = yield* CostLookupService;
      const unavailable = yield* costs.lookupGenerationCost("unavailable");
      const malformed = yield* Effect.exit(costs.lookupGenerationCost("malformed"));
      return { unavailable, malformed };
    }));
    expect(outcomes.unavailable).toBeNull();
    expect(Exit.isFailure(outcomes.malformed)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts the provider request when search is interrupted", async () => {
    let started!: () => void;
    const searching = new Promise<void>((resolve) => { started = resolve; });
    let aborted = false;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => {
        aborted = true;
        reject(init.signal!.reason);
      }, { once: true });
      started();
    }));
    const controller = new AbortController();
    const result = runtime.runPromiseExit(Effect.gen(function* () {
      const search = yield* ParallelSearchService;
      return yield* search.search({ question: "question", query: "query" });
    }), { signal: controller.signal });
    await searching;
    controller.abort();
    expect(Exit.isFailure(await result)).toBe(true);
    expect(aborted).toBe(true);
  });
});
