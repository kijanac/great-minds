import { ConfigProvider, Effect, Exit, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { AppConfigLive } from "../src/config.ts";
import { EmbeddingsLive, EmbeddingsService } from "../src/embeddings.ts";
import { CostLookupLive, CostLookupService } from "../src/llm-costs.ts";
import { LanguageModel, LanguageModelLive } from "../src/llm.ts";
import { ParallelSearchLive, ParallelSearchService } from "../src/parallel.ts";

const runtime = ManagedRuntime.make(Layer.mergeAll(EmbeddingsLive, CostLookupLive, ParallelSearchLive, LanguageModelLive).pipe(
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
  it.each([
    { kind: "stream", headersReceived: false },
    { kind: "stream", headersReceived: true },
    { kind: "complete", headersReceived: false },
    { kind: "complete", headersReceived: true },
  ])("aborts $kind with headers received=$headersReceived when its Effect is interrupted", async ({ kind, headersReceived }) => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    let providerSignal: AbortSignal | null = null;
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      const signal = init.signal!;
      providerSignal = signal;
      if (!headersReceived) {
        ready();
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
        pull() { ready(); },
      }, { highWaterMark: 0 })));
    });
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const result = runtime.runPromiseExit(Effect.gen(function* () {
      const model = yield* LanguageModel;
      const input = { model: "test", messages: [{ role: "user" as const, content: "question" }], tools: [], temperature: 0 };
      if (kind === "stream") {
        yield* Stream.fromAsyncIterable(model.streamChat(input), (error) => error).pipe(Stream.runDrain);
      } else {
        yield* model.complete(input);
      }
    }), { signal: controller.signal });
    await started;
    controller.abort();
    expect(Exit.isFailure(await result)).toBe(true);
    expect(providerSignal).toHaveProperty("aborted", true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds completion retries with exponential backoff and a sixty-second cap", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    await runtime.runPromise(Effect.gen(function* () {
      const model = yield* LanguageModel;
      const fiber = yield* Effect.forkChild(model.complete({ model: "test", messages: [], temperature: 0 }));
      yield* TestClock.adjust(0);
      for (const [index, delay] of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000].entries()) {
        yield* TestClock.adjust(delay - 1);
        expect(fetch).toHaveBeenCalledTimes(index + 1);
        yield* TestClock.adjust(1);
        expect(fetch).toHaveBeenCalledTimes(index + 2);
      }
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
      yield* TestClock.adjust("5 minutes");
      expect(fetch).toHaveBeenCalledTimes(7);
    }).pipe(Effect.provide(TestClock.layer())));
  });

  it.each([false, true])("honors Retry-After with interruption=%s during the wait", async (interrupted) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "120" } }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "Finished." } }] }));
    vi.stubGlobal("fetch", fetch);
    await runtime.runPromise(Effect.gen(function* () {
      const model = yield* LanguageModel;
      const fiber = yield* Effect.forkChild(model.complete({ model: "test", messages: [], temperature: 0 }));
      yield* TestClock.adjust(119_999);
      expect(fetch).toHaveBeenCalledTimes(1);
      if (interrupted) {
        yield* Fiber.interrupt(fiber);
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
        yield* TestClock.adjust("5 minutes");
        expect(fetch).toHaveBeenCalledTimes(1);
      } else {
        yield* TestClock.adjust(1);
        expect(yield* Fiber.join(fiber)).toMatchObject({ text: "Finished." });
        expect(fetch).toHaveBeenCalledTimes(2);
      }
    }).pipe(Effect.provide(TestClock.layer())));
  });

  it("does not retry rejected or malformed completion responses", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ choices: "invalid" }));
    vi.stubGlobal("fetch", fetch);
    await runtime.runPromise(Effect.gen(function* () {
      const model = yield* LanguageModel;
      const request = model.complete({ model: "test", messages: [], temperature: 0 });
      expect(Exit.isFailure(yield* Effect.exit(request))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(request))).toBe(true);
    }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

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
