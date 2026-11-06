import { ConfigProvider, Effect, Exit, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { AppConfigLive } from "../src/config.ts";
import { CostLedger, type CostEntry } from "../src/cost-ledger.ts";
import { EmbeddingsLive, EmbeddingsService } from "../src/embeddings.ts";
import { StructuredLoggerLive } from "../src/logging.ts";
import { CostLookupLive, CostLookupService } from "../src/llm-costs.ts";
import { LanguageModel, LanguageModelLive } from "../src/llm.ts";
import { ParallelSearchLive, ParallelSearchService } from "../src/parallel.ts";

const recorded: CostEntry[] = [];
const LedgerLive = Layer.mergeAll(
  Layer.succeed(CostLedger, { record: (entry) => Effect.sync(() => { recorded.push(entry); }) }),
  StructuredLoggerLive,
);

const runtime = ManagedRuntime.make(Layer.mergeAll(EmbeddingsLive, CostLookupLive, ParallelSearchLive, LanguageModelLive).pipe(
  Layer.provide(LedgerLive),
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

const directRuntime = ManagedRuntime.make(Layer.mergeAll(EmbeddingsLive, LanguageModelLive).pipe(
  Layer.provide(LedgerLive),
  Layer.provide(AppConfigLive),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {
    DATABASE_URL: "postgresql://great-minds.test/great_minds",
    JWT_SECRET: "provider-adapter-test-secret",
    OPENROUTER_API_KEY: "provider-test-key",
    PROVIDERS: "moonshot,local",
    PROVIDER_MOONSHOT_URL: "https://api.moonshot.test/v1",
    PROVIDER_MOONSHOT_KEY: "moonshot-key",
    PROVIDER_LOCAL_URL: "http://studio.test:8080/v1",
    RENDER_MODEL: "moonshot:kimi-k3",
    EMBEDDING_MODEL: "local:qwen3-embedding-8b",
    MODEL_PRICES: "moonshot:kimi-k3=1/4,local:qwen3-embedding-8b=0/0",
  } }))),
));

afterAll(() => directRuntime.dispose());

describe("direct providers", () => {
  it("sends a direct provider standard fields only, at its own address, priced from config", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({
      id: "moonshot-generation",
      choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000, completion_tokens: 500 },
    }));
    vi.stubGlobal("fetch", fetch);
    const completion = await directRuntime.runPromise(Effect.flatMap(LanguageModel, (model) => model.complete({
      model: "moonshot:kimi-k3",
      messages: [{ role: "user", content: "question" }],
      reasoningEffort: "low",
      responseFormat: "json_object",
      requestProfile: "compile",
    })));
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.moonshot.test/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer moonshot-key");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "kimi-k3",
      messages: [{ role: "user", content: "question" }],
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      stream: false,
    });
    expect(completion.generationId).toBeUndefined();
    expect(completion.usage?.cost).toBeCloseTo(0.003);
  });

  it("records each embedding batch's cost: the provider's figure, or tokens at the configured price", async () => {
    recorded.length = 0;
    const scope = { vaultId: "00000000-0000-4000-8000-000000000001" as never, eventType: "compile" as const, phase: "embed:ideas" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [{ index: 0, embedding: [1, 0] }],
      usage: { prompt_tokens: 2_000, cost: 0.00004 },
    })));
    await runtime.runPromise(Effect.flatMap(EmbeddingsService, (embeddings) => embeddings.embed(["text"], scope)));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [{ index: 0, embedding: [1, 0] }],
      usage: { prompt_tokens: 2_000 },
    })));
    await directRuntime.runPromise(Effect.flatMap(EmbeddingsService, (embeddings) => embeddings.embed(["text"], scope)));
    await runtime.runPromise(Effect.flatMap(EmbeddingsService, (embeddings) => embeddings.embed(["text"])));
    expect(recorded.map((entry) => [entry.model, entry.promptTokens, entry.costUsd])).toEqual([
      ["qwen/qwen3-embedding-8b", 2_000, 0.00004],
      ["local:qwen3-embedding-8b", 2_000, 0],
    ]);
  });

  it("embeds through a keyless local provider without OpenRouter routing", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({
      data: [{ index: 0, embedding: [1, 0] }],
    }));
    vi.stubGlobal("fetch", fetch);
    await directRuntime.runPromise(Effect.flatMap(EmbeddingsService, (embeddings) => embeddings.embed(["text"])));
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://studio.test:8080/v1/embeddings");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({
      input: ["text"],
      model: "qwen3-embedding-8b",
      encoding_format: "base64",
    });
  });
});

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
        yield* model.streamChat(input).pipe(Stream.runDrain);
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

  it("retries server errors and cut-off completion bodies twice", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response('{"choices": [', { status: 200 }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "Recovered." } }] }));
    vi.stubGlobal("fetch", fetch);
    await runtime.runPromise(Effect.gen(function* () {
      const model = yield* LanguageModel;
      const fiber = yield* Effect.forkChild(model.complete({ model: "test", messages: [], temperature: 0 }));
      yield* TestClock.adjust(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust(2_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      yield* TestClock.adjust(4_000);
      expect(yield* Fiber.join(fiber)).toMatchObject({ text: "Recovered." });
      expect(fetch).toHaveBeenCalledTimes(3);
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
      provider: { order: ["deepinfra", "nebius"], allow_fallbacks: false },
    });
  }, 10_000);

  it("waits out embedding rate limits like completions instead of failing the batch", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "30" } }))
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ data: [{ index: 0, embedding: [1, 0] }] }));
    vi.stubGlobal("fetch", fetch);
    await runtime.runPromise(Effect.gen(function* () {
      const embeddings = yield* EmbeddingsService;
      const fiber = yield* Effect.forkChild(embeddings.embed(["alpha"]));
      yield* TestClock.adjust(29_999);
      expect(fetch).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      yield* TestClock.adjust(4_000);
      expect(fetch).toHaveBeenCalledTimes(3);
      yield* TestClock.adjust(8_000);
      expect(yield* Fiber.join(fiber)).toEqual([[1, 0]]);
      expect(fetch).toHaveBeenCalledTimes(4);
    }).pipe(Effect.provide(TestClock.layer())));
  });

  it("waits at least its own backoff when the provider asks for a shorter wait", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "1" } }))
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "1" } }))
      .mockResolvedValueOnce(Response.json({ data: [{ index: 0, embedding: [1, 0] }] }));
    vi.stubGlobal("fetch", fetch);
    await runtime.runPromise(Effect.gen(function* () {
      const embeddings = yield* EmbeddingsService;
      const fiber = yield* Effect.forkChild(embeddings.embed(["alpha"]));
      yield* TestClock.adjust(1_999);
      expect(fetch).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      yield* TestClock.adjust(3_999);
      expect(fetch).toHaveBeenCalledTimes(2);
      yield* TestClock.adjust(1);
      expect(yield* Fiber.join(fiber)).toEqual([[1, 0]]);
      expect(fetch).toHaveBeenCalledTimes(3);
    }).pipe(Effect.provide(TestClock.layer())));
  });

  it("names the provider's status, wait and reason when an embedding batch is refused", async () => {
    const fetch = vi.fn(async () =>
      new Response('{"error":{"message":"Rate limit exceeded: free-models-per-day"}}', {
        status: 429,
        headers: { "retry-after": "1" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const failure = await runtime.runPromise(Effect.gen(function* () {
      const embeddings = yield* EmbeddingsService;
      const fiber = yield* Effect.forkChild(Effect.flip(embeddings.embed(["alpha"])));
      yield* TestClock.adjust("10 minutes");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())));
    expect(failure.message).toBe(
      'embedding provider rate limited request (429: retry-after 1: {"error":{"message":"Rate limit exceeded: free-models-per-day"}})',
    );
  });

  it("aborts a generation-cost body read when its Effect is interrupted", async () => {
    let ready!: () => void;
    const reading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let lookupSignal: AbortSignal | null = null;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      const signal = init.signal!;
      lookupSignal = signal;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
        pull() { ready(); },
      }, { highWaterMark: 0 })));
    });
    const controller = new AbortController();
    const result = runtime.runPromiseExit(
      Effect.flatMap(CostLookupService, (costs) => costs.lookupGenerationCost("generation")),
      { signal: controller.signal },
    );
    await reading;
    controller.abort();
    expect(Exit.isFailure(await result)).toBe(true);
    expect(lookupSignal).toHaveProperty("aborted", true);
  });

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
