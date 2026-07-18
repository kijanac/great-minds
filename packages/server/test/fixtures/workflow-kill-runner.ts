import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Layer, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import * as Workflow from "effect/unstable/workflow/Workflow";

import { AppConfigLive } from "../../src/config.ts";
import { WorkflowEngineLive } from "../../src/workflow-engine.ts";

const runId = process.argv[2];
const pauseBeforeFinishCommit = process.argv[3] === "pause";
const sideEffectDir = process.argv[4];

if (runId === undefined || sideEffectDir === undefined) {
  throw new Error("workflow run id and side-effect directory arguments are required");
}

const KernelAcceptanceWorkflow = Workflow.make("KernelAcceptance", {
  payload: { runId: Schema.String },
  idempotencyKey: ({ runId: id }) => id,
  success: Schema.String,
});

const WorkflowLayer = KernelAcceptanceWorkflow.toLayer((payload, executionId) => {
  const prepare = Activity.make({
    name: "kernel-prepare",
    success: Schema.String,
    execute: Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeFile(join(sideEffectDir, `${payload.runId}-prepare`), "prepared", { flag: "wx" }),
      ).pipe(Effect.orDie);
      console.log("KERNEL prepare side-effect");
      return "prepared";
    }),
  });
  const finish = Activity.make({
    name: "kernel-finish",
    success: Schema.String,
    execute: Effect.gen(function* () {
      console.log(`KERNEL finish activity started run=${payload.runId}`);
      if (pauseBeforeFinishCommit) {
        yield* Effect.sleep("60 seconds");
      }
      yield* Effect.tryPromise(() =>
        writeFile(join(sideEffectDir, `${payload.runId}-finish`), "finished", { flag: "wx" }),
      ).pipe(Effect.orDie);
      console.log("KERNEL finish side-effect inserted");
      return "finished";
    }),
  });
  return Effect.gen(function* () {
      console.log(`KERNEL execution=${executionId}`);
      const prepared = yield* prepare;
      const finished = yield* finish;
      return `${prepared}+${finished}`;
    });
});

const MainLive = WorkflowLayer.pipe(
  Layer.provideMerge(WorkflowEngineLive),
  Layer.provide(AppConfigLive),
);

const result = await Effect.runPromise(
  KernelAcceptanceWorkflow.execute({ runId }).pipe(Effect.provide(MainLive)),
);
console.log(`KERNEL completed result=${result}`);
