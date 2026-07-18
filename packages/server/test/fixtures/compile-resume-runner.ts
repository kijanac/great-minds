import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Uuid } from "@great-minds/domain";
import { Effect, Layer } from "effect";

import { AppConfigLive } from "../../src/config.ts";
import { ClockLive } from "../../src/clock.ts";
import {
  cancelCompileWorkflow,
  CompileWorkflow,
  CompileWorkflowLive,
} from "../../src/compile-intents.ts";
import {
  CompilePhaseNotPorted,
  CompilePhases,
  EXTRACT_STEP_LABELS,
} from "../../src/compile-phases.ts";
import { DrizzleLive } from "../../src/db.ts";
import { StructuredLoggerLive } from "../../src/logging.ts";
import {
  PipelineRunsService,
  PipelineRunsServiceLive,
  progressSteps,
} from "../../src/pipeline-runs.ts";
import { WorkflowEngineLive } from "../../src/workflow-engine.ts";

const mode = process.argv[2] as "pause" | "resume" | "cancel" | undefined;
const intentId = process.argv[3] as Uuid | undefined;
const vaultId = process.argv[4] as Uuid | undefined;
const runId = process.argv[5] as Uuid | undefined;
const markerDir = process.argv[6];
if (
  mode === undefined ||
  intentId === undefined ||
  vaultId === undefined ||
  runId === undefined ||
  markerDir === undefined
) {
  throw new Error("mode, intent id, vault id, run id, and marker directory are required");
}

const marker = (name: string, options?: { flag: "wx" }) =>
  Effect.tryPromise(() => writeFile(join(markerDir, name), name, options)).pipe(Effect.orDie);

const PhasesLive = Layer.effect(
  CompilePhases,
  Effect.gen(function* () {
    const pipeline = yield* PipelineRunsService;
    return {
    archiveTransitions: () => Effect.void,
    flushLlmCost: () => Effect.void,
      ingest: () =>
        marker("ingest", { flag: "wx" }).pipe(
          Effect.tap(() => Effect.sync(() => console.log("COMPILE ingest executed"))),
        ),
      extract: (_vaultId, pipelineRunId) =>
        marker("extract-started").pipe(
          Effect.tap(() => Effect.sync(() => console.log("COMPILE extract started"))),
          Effect.andThen(
            mode === "resume"
              ? Effect.gen(function* () {
                  const failure = new CompilePhaseNotPorted({
                    phase: "extract",
                    message: "resume seam",
                  });
                  yield* pipeline.updateProgress(
                    pipelineRunId,
                    "extract",
                    "failed",
                    progressSteps(EXTRACT_STEP_LABELS, "extract_cards", {
                      failed: new Set(["extract_cards"]),
                      details: { extract_cards: failure.message },
                    }),
                    failure.message,
                  );
                  return yield* Effect.fail(failure);
                })
              : Effect.sleep("60 seconds"),
          ),
        ),
      abstract: () => Effect.die("abstract unexpectedly reached"),
      derive: () => Effect.die("derive unexpectedly reached"),
      render: () => Effect.die("render unexpectedly reached"),
      verify: () => Effect.die("verify unexpectedly reached"),
      publish: () => Effect.die("publish unexpectedly reached"),
    };
  }),
);

const BaseLive = Layer.mergeAll(
  DrizzleLive.pipe(Layer.provideMerge(AppConfigLive)),
  ClockLive,
  StructuredLoggerLive,
);
const PipelineLive = PipelineRunsServiceLive.pipe(Layer.provideMerge(BaseLive));
const PhasesProvidedLive = PhasesLive.pipe(Layer.provideMerge(PipelineLive));
const EngineLive = WorkflowEngineLive.pipe(Layer.provideMerge(BaseLive));
const HandlersLive = CompileWorkflowLive.pipe(
  Layer.provideMerge(PhasesProvidedLive),
  Layer.provideMerge(PipelineLive),
  Layer.provideMerge(EngineLive),
);
const MainLive = Layer.mergeAll(
  HandlersLive.pipe(Layer.provideMerge(EngineLive)),
  PipelineLive,
  BaseLive,
);
const payload = { intentId, vaultId, pipelineRunId: runId };

if (mode === "cancel") {
  const executionId = await Effect.runPromise(
    Effect.gen(function* () {
      const executionId = yield* CompileWorkflow.execute(payload, { discard: true });
      yield* Effect.tryPromise(async () => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          try {
            await readFile(join(markerDir, "extract-started"));
            return;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        throw new Error("extract activity did not start");
      });
      yield* cancelCompileWorkflow(runId, executionId);
      return executionId;
    }).pipe(Effect.provide(MainLive)),
  );
  console.log(`COMPILE cancelled execution=${executionId}`);
} else {
  const result = await Effect.runPromise(
    Effect.result(CompileWorkflow.execute(payload)).pipe(Effect.provide(MainLive)),
  );
  console.log(`COMPILE result=${result._tag}`);
  if (result._tag === "Failure") console.log(`COMPILE failure=${JSON.stringify(result.failure)}`);
}
