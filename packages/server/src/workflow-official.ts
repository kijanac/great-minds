/**
 * Spike Zero Round 2: durability through the OFFICIAL Effect v4 workflow stack.
 *
 * Uses `effect/unstable/workflow` (Workflow + Activity) executed by
 * `effect/unstable/cluster` (ClusterWorkflowEngine + SingleRunner) with
 * Postgres-backed message storage via `@effect/sql-pg`. Single process, no
 * infrastructure beyond Postgres.
 *
 * Proof protocol:
 *   1. First run with SPIKE_KILL_AFTER_CHECKPOINT=1: activity `prepare`
 *      completes (its result is persisted by the engine), activity `finish`
 *      starts and SIGKILLs the process before completing.
 *   2. Second run without the kill flag and the same SPIKE_WORKFLOW_ID:
 *      the engine replays `prepare` from storage (its body must NOT log
 *      "executing" again), runs `finish` to completion, and the workflow
 *      returns its result.
 */
import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer, Redacted, Schema } from "effect";
import * as ClusterWorkflowEngine from "effect/unstable/cluster/ClusterWorkflowEngine";
import * as SingleRunner from "effect/unstable/cluster/SingleRunner";
import * as Activity from "effect/unstable/workflow/Activity";
import * as Workflow from "effect/unstable/workflow/Workflow";

const safeLocalDatabaseUrl = () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the official workflow durability check");
  }
  const parsed = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error(`Refusing to run workflow check against non-local host ${parsed.hostname}`);
  }
  if (!parsed.pathname.endsWith("gm_spike")) {
    throw new Error(`Refusing to run workflow check against database ${parsed.pathname}`);
  }
  return databaseUrl;
};

const runId = process.env.SPIKE_WORKFLOW_ID ?? "spike-zero-official";
const killDuringFinish = process.env.SPIKE_KILL_AFTER_CHECKPOINT === "1";

const SpikeWorkflow = Workflow.make("SpikeZeroOfficial", {
  payload: {
    runId: Schema.String
  },
  idempotencyKey: ({ runId }) => runId,
  success: Schema.String
});

const prepare = Activity.make({
  name: "prepare",
  success: Schema.String,
  execute: Effect.gen(function* () {
    console.log("[official] activity=prepare executing (must only appear on the first run)");
    yield* Effect.sleep("500 millis");
    console.log("[official] activity=prepare complete; engine persists its result");
    return "prepared";
  })
});

const finish = Activity.make({
  name: "finish",
  success: Schema.String,
  execute: Effect.gen(function* () {
    console.log("[official] activity=finish executing");
    if (killDuringFinish) {
      console.log("[official] SIGKILL now: prepare is checkpointed, finish is incomplete");
      process.kill(process.pid, "SIGKILL");
    }
    yield* Effect.sleep("500 millis");
    console.log("[official] activity=finish complete");
    return "finished";
  })
});

const SpikeWorkflowLayer = SpikeWorkflow.toLayer(
  (payload, executionId) =>
    Effect.gen(function* () {
      console.log(
        `[official] workflow body start runId=${payload.runId} executionId=${executionId}`
      );
      const prepared = yield* prepare;
      const finished = yield* finish;
      return `${prepared}+${finished}`;
    })
);

// Single process topology: SingleRunner colocates Sharding + Runners +
// MessageStorage (SQL-backed) in this one process. Runner registration/shard
// locks use in-memory storage so a SIGKILLed run does not leave a stale SQL
// shard lock (default expiration 35s); durable workflow state still lives in
// the SQL message storage.
const SqlLive = PgClient.layer({ url: Redacted.make(safeLocalDatabaseUrl()) });
const ClusterLive = SingleRunner.layer({ runnerStorage: "memory" }).pipe(Layer.provide(SqlLive));
const EngineLive = ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(ClusterLive));
const MainLive = SpikeWorkflowLayer.pipe(Layer.provideMerge(EngineLive));

const program = Effect.gen(function* () {
  console.log(
    `[official] requesting execution runId=${runId} killDuringFinish=${killDuringFinish}`
  );
  const result = yield* SpikeWorkflow.execute({ runId });
  console.log(`[official] workflow completed runId=${runId} result=${result}`);
});

await Effect.runPromise(program.pipe(Effect.provide(MainLive)));
process.exit(0);
