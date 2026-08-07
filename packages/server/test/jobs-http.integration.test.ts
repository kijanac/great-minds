import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authCodes,
  backlinks,
  compileIntents,
  Database,
  llmCostEvents,
  pipelineRuns,
  topicLinks,
  topics,
  users,
  vaultMemberships,
  vaults,
  wikiArticles,
} from "@great-minds/database";
import type { Uuid } from "@great-minds/domain";
import { eq } from "drizzle-orm";
import { Cause, Channel, Effect, Exit, Layer, Option, Redacted, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAppLayer } from "../src/app-layer.ts";
import { ClockService, makeTestClock } from "../src/clock.ts";
import { AppConfig, type AppConfigShape } from "../src/config.ts";
import { jobSseStream } from "../src/jobs.ts";
import { StructuredLogger, StructuredLoggerLive } from "../src/logging.ts";
import { makeTestMailer } from "../src/mailer.ts";
import { jobSseHeartbeatChunk, startServer } from "../src/server.ts";
import { TokenService } from "../src/tokens.ts";

const now = new Date("2026-07-12T12:00:00.000Z");
const ids = {
  alice: "00000000-0000-4000-8000-000000060001",
  bob: "00000000-0000-4000-8000-000000060002",
  vault: "00000000-0000-4000-8000-000000060101",
  otherVault: "00000000-0000-4000-8000-000000060102",
  run: "00000000-0000-4000-8000-000000060201",
  secondRun: "00000000-0000-4000-8000-000000060202",
  missingRun: "00000000-0000-4000-8000-000000060299",
  topicAlpha: "00000000-0000-4000-8000-000000060301",
  topicBeta: "00000000-0000-4000-8000-000000060302",
  articleAlpha: "00000000-0000-4000-8000-000000060401",
  articleBeta: "00000000-0000-4000-8000-000000060402",
} as const;

type Services = AppConfig | Database | ClockService | StructuredLogger | TokenService;
type State = {
  readonly started: Awaited<ReturnType<typeof startServer>>;
  readonly dataDir: string;
  readonly aliceToken: string;
  readonly bobToken: string;
};

let state: State | undefined;

const current = () => {
  if (state === undefined) throw new Error("test harness is not started");
  return state;
};

const databaseUrl = () => {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value.length === 0) throw new Error("DATABASE_URL is required");
  return value;
};

const config = (dataDir: string): AppConfigShape => ({
  databaseUrl: Redacted.make(databaseUrl()),
  jwtSecret: Redacted.make("jobs-http-test-secret"),
  jwtAccessExpiryMinutes: 30,
  jwtRefreshExpiryDays: 7,
  authCodeExpiryMinutes: 10,
  webauthnRpId: "localhost",
  webauthnOrigins: ["http://localhost:5173"],
  webauthnRpName: "Great Minds",
  resendApiKey: Option.none(),
  resendFromEmail: Option.none(),
  dataDir,
  storageBackend: "local",
  r2AccountId: Option.none(),
  r2AccessKeyId: Option.none(),
  r2SecretAccessKey: Option.none(),
  r2BucketPrefix: "gm-test",
  openRouterApiKey: Option.some(Redacted.make("test-openrouter-key")),
  openRouterApiUrl: "https://openrouter.ai/api/v1",
  parallelApiKey: Option.none(),
  parallelSearchUrl: "https://api.parallel.ai/v1beta/search",
  queryModel: "query/test",
  queryFallbackModels: ["query/fallback"],
  extractModel: "extract/test",
  mapModel: "map/test",
  reduceModel: "reduce/test",
  renderModel: "render/test",
  compileEnrichConcurrency: 1,
  compileWriteConcurrency: 1,
  compilePartitionTargetTokens: 100_000,
  compilePartitionMinFactor: 0.3,
  compilePartitionMaxFactor: 1.5,
  compilePremergeJaccardThreshold: 0.8,
  compileDeriveRelatedLimit: 20,
  pipelineConcurrency: 1,
  goldensRandomSeed: Option.none(),
  goldensClock: Option.none(),
  embeddingModel: "embedding/test",
  corsOrigins: ["http://localhost:5173"],
  suppressAuth: false,
  serverHost: "127.0.0.1",
  serverPort: 0,
});

const run = <A>(effect: Effect.Effect<A, unknown, Services>) =>
  current().started.runtime.runPromise(effect);

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const request = (path: string, token: string, init?: RequestInit) =>
  fetch(`${current().started.url}${path}`, {
    ...init,
    headers: {
      ...auth(token),
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const seed = () =>
  run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.query((d) => d.delete(authCodes)).pipe(Effect.orDie);
      yield* db.query((d) => d.delete(users)).pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(users)
        .values([
          { id: ids.alice, email: "jobs-alice@example.test", createdAt: now },
          { id: ids.bob, email: "jobs-bob@example.test", createdAt: now },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(vaults)
        .values([
          { id: ids.vault, ownerId: ids.alice, name: "Jobs Vault", createdAt: now },
          { id: ids.otherVault, ownerId: ids.bob, name: "Other Vault", createdAt: now },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(vaultMemberships)
        .values([
          {
            id: "00000000-0000-4000-8000-000000060501",
            vaultId: ids.vault,
            userId: ids.alice,
            role: "OWNER",
            createdAt: now,
          },
          {
            id: "00000000-0000-4000-8000-000000060502",
            vaultId: ids.otherVault,
            userId: ids.bob,
            role: "OWNER",
            createdAt: now,
          },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(topics)
        .values([
          {
            topicId: ids.topicAlpha,
            vaultId: ids.vault,
            slug: "alpha",
            title: "Alpha",
            description: "Alpha topic",
            articleStatus: "rendered",
            compiledFromHash: "new-alpha",
            renderedFromHash: "old-alpha",
          },
          {
            topicId: ids.topicBeta,
            vaultId: ids.vault,
            slug: "beta",
            title: "Beta",
            description: "Beta topic",
            articleStatus: "rendered",
            compiledFromHash: "same-beta",
            renderedFromHash: "same-beta",
          },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(wikiArticles)
        .values([
          {
            id: ids.articleAlpha,
            vaultId: ids.vault,
            topicId: ids.topicAlpha,
            filePath: "wiki/alpha.md",
            fileHash: "file-alpha",
            bodyHash: "body-alpha",
            title: "Alpha",
            precis: "Alpha precis",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: ids.articleBeta,
            vaultId: ids.vault,
            topicId: ids.topicBeta,
            filePath: "wiki/beta.md",
            fileHash: "file-beta",
            bodyHash: "body-beta",
            title: "Beta",
            precis: "Beta precis",
            createdAt: now,
            updatedAt: now,
          },
        ]))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(backlinks)
        .values({ sourceArticleId: ids.articleAlpha, targetArticleId: ids.articleBeta }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(topicLinks)
        .values({ sourceTopicId: ids.topicBeta, targetTopicId: ids.topicAlpha }))
        .pipe(Effect.orDie);
      yield* db.query((d) => d
        .insert(llmCostEvents)
        .values([
          {
            userId: ids.alice,
            vaultId: ids.vault,
            eventType: "compile",
            costUsd: "1.000000",
            createdAt: new Date("2026-07-10T12:00:00Z"),
          },
          {
            userId: ids.alice,
            vaultId: ids.otherVault,
            eventType: "query",
            costUsd: "2.000000",
            createdAt: new Date("2026-07-11T12:00:00Z"),
          },
          {
            userId: ids.bob,
            vaultId: ids.vault,
            eventType: "render",
            costUsd: "3.000000",
            createdAt: new Date("2026-07-12T12:00:00Z"),
          },
        ]))
        .pipe(Effect.orDie);
    }),
  );

beforeEach(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "great-minds-jobs-http-"));
  const clock = makeTestClock(now);
  const layer = makeAppLayer({
    config: Layer.succeed(AppConfig, config(dataDir)),
    clock: clock.layer,
    mailer: makeTestMailer().layer,
    logger: StructuredLoggerLive,
  });
  const started = await startServer({ layer, host: "127.0.0.1", port: 0 });
  state = { started, dataDir, aliceToken: "", bobToken: "" };
  await seed();
  const [aliceToken, bobToken] = await Promise.all([
    run(Effect.flatMap(TokenService, (tokens) => tokens.issueAccessToken(ids.alice as Uuid, now))),
    run(Effect.flatMap(TokenService, (tokens) => tokens.issueAccessToken(ids.bob as Uuid, now))),
  ]);
  state = { started, dataDir, aliceToken, bobToken };
});

afterEach(async () => {
  const active = state;
  state = undefined;
  if (active !== undefined) {
    await active.started.close();
    await rm(active.dataDir, { recursive: true, force: true });
  }
});

describe("compile and job HTTP routes", () => {
  it("submits a fresh run, coalesces against the pending intent, lists it, and reads it", async () => {
    const first = await request(`/v1/vaults/${ids.vault}/compile`, current().aliceToken, {
      method: "POST",
      body: JSON.stringify({ job_id: ids.run }),
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({
      id: ids.run,
      vault_id: ids.vault,
      trigger: "manual",
      status: "pending",
      current_phase: "",
      phase_status: "",
      progress_steps: [],
      error: null,
      stream_url: `/jobs/${ids.run}/stream`,
    });

    const second = await request(`/v1/vaults/${ids.vault}/compile`, current().aliceToken, {
      method: "POST",
      body: JSON.stringify({ job_id: ids.secondRun }),
    });
    expect(second.status).toBe(202);
    expect((await second.json()).id).toBe(ids.run);

    const stored = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return {
          runs: yield* db.query((d) => d.select().from(pipelineRuns)).pipe(Effect.orDie),
          intents: yield* db.query((d) => d.select().from(compileIntents)).pipe(Effect.orDie),
        };
      }),
    );
    expect(stored.runs.map((row) => row.id)).toEqual([ids.run]);
    expect(stored.intents).toHaveLength(1);
    expect(stored.intents[0]?.pipelineRunId).toBe(ids.run);

    const list = await request(`/v1/vaults/${ids.vault}/jobs?status=active`, current().aliceToken);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [{ id: ids.run }], pagination: { total: 1 } });
    const get = await request(`/v1/vaults/${ids.vault}/jobs/${ids.run}`, current().aliceToken);
    expect(get.status).toBe(200);
    expect((await get.json()).id).toBe(ids.run);
    const invalid = await request(
      `/v1/vaults/${ids.vault}/jobs?status=unknown`,
      current().aliceToken,
    );
    expect(invalid.status).toBe(422);
  });

  it("cancels idempotently without clobbering terminal state or revealing foreign runs", async () => {
    await run(
      Effect.flatMap(Database, (db) =>
        db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: ids.run,
            vaultId: ids.vault,
            trigger: "manual",
            status: "pending",
            currentPhase: "",
            phaseStatus: "",
            progressSteps: [],
          }))
          .pipe(Effect.orDie),
      ),
    );
    const cancel = await request(
      `/v1/vaults/${ids.vault}/compile/${ids.run}/cancel`,
      current().aliceToken,
      { method: "POST" },
    );
    expect(cancel.status).toBe(204);
    const again = await request(
      `/v1/vaults/${ids.vault}/compile/${ids.run}/cancel`,
      current().aliceToken,
      { method: "POST" },
    );
    expect(again.status).toBe(204);
    const missing = await request(
      `/v1/vaults/${ids.vault}/compile/${ids.missingRun}/cancel`,
      current().aliceToken,
      { method: "POST" },
    );
    expect(missing.status).toBe(204);
    const row = await run(
      Effect.flatMap(Database, (db) =>
        db.query((d) => d.select().from(pipelineRuns).where(eq(pipelineRuns.id, ids.run))).pipe(Effect.orDie),
      ),
    );
    expect(row[0]?.status).toBe("cancelled");
    expect(row[0]?.phaseStatus).toBe("failed");
  });

  it("collapses non-membership to 403 and returns 404 only inside an accessible vault", async () => {
    const forbidden = await request(
      `/v1/vaults/${ids.vault}/jobs/${ids.missingRun}`,
      current().bobToken,
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      detail: "Only vault members can perform this action",
    });
    const missing = await request(
      `/v1/vaults/${ids.vault}/jobs/${ids.missingRun}`,
      current().aliceToken,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: "Job not found" });
  });
});

describe("lint and cost HTTP routes", () => {
  it("returns the exact lint response shapes", async () => {
    const response = await request(`/v1/vaults/${ids.vault}/lint`, current().aliceToken);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      orphans: [
        {
          file_path: "wiki/alpha.md",
          title: "Alpha",
          precis: "Alpha precis",
          updated_at: now.toISOString(),
          slug: "alpha",
        },
      ],
      dirty_topics: [ids.topicAlpha],
      unmentioned_links: [
        { source_slug: "beta", source_title: "Beta", target_slug: "alpha", target_title: "Alpha" },
      ],
    });
  });

  it("aggregates user and vault costs over inclusive fixed windows", async () => {
    const user = await request(
      "/v1/costs?since=2026-07-11T00:00:00Z&until=2026-07-12T00:00:00Z",
      current().aliceToken,
    );
    expect(user.status).toBe(200);
    expect(await user.json()).toEqual({
      total_usd: "2.000000",
      event_count: 1,
      by_vault: [{ key: ids.otherVault, total_usd: "2.000000", event_count: 1 }],
      by_event_type: [{ key: "query", total_usd: "2.000000", event_count: 1 }],
    });
    const vault = await request(`/v1/vaults/${ids.vault}/costs`, current().aliceToken);
    expect(vault.status).toBe(200);
    expect(await vault.json()).toEqual({
      total_usd: "4.000000",
      event_count: 2,
      by_vault: [{ key: ids.vault, total_usd: "4.000000", event_count: 2 }],
      by_event_type: [
        { key: "render", total_usd: "3.000000", event_count: 1 },
        { key: "compile", total_usd: "1.000000", event_count: 1 },
      ],
    });
    const forbidden = await request(`/v1/vaults/${ids.vault}/costs`, current().bobToken);
    expect(forbidden.status).toBe(403);
  });
});

type ParsedEvent = { readonly event: string; readonly data: unknown };

const parseSse = (text: string): readonly ParsedEvent[] =>
  text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice("event: ".length);
        if (line.startsWith("data: ")) data += line.slice("data: ".length);
      }
      return { event, data: JSON.parse(data) as unknown };
    });

describe("job progress SSE", () => {
  it("pins Effect's empty-message encoding and singleton chunks for heartbeat rewriting", async () => {
    const empty = { _tag: "Event" as const, id: undefined, event: "message", data: "" };
    expect(Sse.encoder.write(empty)).toBe("\n");
    expect(new TextDecoder().decode(jobSseHeartbeatChunk(new Uint8Array([10])))).toBe(
      ": heartbeat\n\n",
    );

    async function* consecutiveEvents() {
      yield { _tag: "Event" as const, id: undefined, event: "first", data: "one" };
      yield { _tag: "Event" as const, id: undefined, event: "second", data: "two" };
    }
    const encoded = Stream.fromChannel(
      Channel.pipeTo(
        Stream.toChannel(jobSseStream(consecutiveEvents())),
        Sse.encode<never, void>(),
      ),
    );
    const chunks = await Effect.runPromise(Stream.runCollect(Stream.chunks(encoded)));
    expect(chunks).toEqual([["event: first\ndata: one\n\n"], ["event: second\ndata: two\n\n"]]);
  });

  it("maps async SSE iterator failures to the original defect", async () => {
    const defect = new Error("mid-stream database defect");
    async function* failingEvents() {
      yield "connected";
      throw defect;
    }

    const exit = await Effect.runPromiseExit(Stream.runCollect(jobSseStream(failingEvents())));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0];
      expect(reason !== undefined && Cause.isDieReason(reason)).toBe(true);
      if (reason !== undefined && Cause.isDieReason(reason)) expect(reason.defect).toBe(defect);
    }
  });

  it("streams current-state transitions through terminal in exact protocol order", async () => {
    await run(
      Effect.flatMap(Database, (db) =>
        db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: ids.run,
            vaultId: ids.vault,
            trigger: "manual",
            status: "pending",
            currentPhase: "",
            phaseStatus: "",
            progressSteps: [],
            createdAt: now,
            updatedAt: now,
          }))
          .pipe(Effect.orDie),
      ),
    );
    const response = await request(
      `/v1/vaults/${ids.vault}/jobs/${ids.run}/stream`,
      current().aliceToken,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const body = response.text();
    await wait(180);
    await run(
      Effect.flatMap(Database, (db) =>
        db.query((d) => d
          .update(pipelineRuns)
          .set({
            status: "running",
            currentPhase: "ingest",
            phaseStatus: "progress",
            progressSteps: [
              {
                key: "index_sources",
                label: "Indexing for search",
                status: "running",
                done: 1,
                total: 2,
                detail: "",
              },
            ],
            updatedAt: new Date("2026-07-12T12:00:01Z"),
          })
          .where(eq(pipelineRuns.id, ids.run)))
          .pipe(Effect.orDie),
      ),
    );
    await wait(180);
    await run(
      Effect.flatMap(Database, (db) =>
        db.query((d) => d
          .update(pipelineRuns)
          .set({
            status: "completed",
            currentPhase: "publish",
            phaseStatus: "completed",
            progressSteps: [
              {
                key: "finalize_compile",
                label: "Finalizing compile",
                status: "completed",
                done: 1,
                total: 1,
                detail: "",
              },
            ],
            updatedAt: new Date("2026-07-12T12:00:02Z"),
            completedAt: new Date("2026-07-12T12:00:02Z"),
          })
          .where(eq(pipelineRuns.id, ids.run)))
          .pipe(Effect.orDie),
      ),
    );
    const events = parseSse(await body);
    expect(events.map((event) => event.event)).toEqual([
      "connected",
      "message",
      "message",
      "message",
      "done",
    ]);
    expect(events[0]?.data).toEqual({ id: ids.run });
    expect(
      events.slice(1, 4).map((event) => (event.data as { job_status: string }).job_status),
    ).toEqual(["pending", "running", "completed"]);
    expect(events[4]?.data).toEqual({ id: ids.run });
  });

  it("reconnects to a terminal run with snapshot-first one-shot closure", async () => {
    await run(
      Effect.flatMap(Database, (db) =>
        db.query((d) => d
          .insert(pipelineRuns)
          .values({
            id: ids.run,
            vaultId: ids.vault,
            trigger: "manual",
            status: "failed",
            currentPhase: "extract",
            phaseStatus: "failed",
            progressSteps: [],
            error: "extract seam unavailable",
            completedAt: now,
          }))
          .pipe(Effect.orDie),
      ),
    );
    const response = await request(
      `/v1/vaults/${ids.vault}/jobs/${ids.run}/stream`,
      current().aliceToken,
    );
    const events = parseSse(await response.text());
    expect(events.map((event) => event.event)).toEqual(["connected", "message", "done"]);
    expect(events[1]?.data).toMatchObject({
      job_status: "failed",
      error: "extract seam unavailable",
    });
  });

  it("returns 403 and 404 as JSON before opening the stream", async () => {
    const forbidden = await request(
      `/v1/vaults/${ids.vault}/jobs/${ids.missingRun}/stream`,
      current().bobToken,
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    const missing = await request(
      `/v1/vaults/${ids.vault}/jobs/${ids.missingRun}/stream`,
      current().aliceToken,
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type") ?? "").not.toContain("text/event-stream");
  });
});
