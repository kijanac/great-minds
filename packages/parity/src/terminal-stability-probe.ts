import { Effect, Layer, ManagedRuntime } from "effect";

import { AppConfigLive } from "../../server/src/config.ts";
import { DrizzleLive } from "../../server/src/db.ts";
import { PipelineRunsService, PipelineRunsServiceLive } from "../../server/src/pipeline-runs.ts";
import { ids } from "./fixture.ts";

const database = DrizzleLive.pipe(Layer.provideMerge(AppConfigLive));
const pipeline = PipelineRunsServiceLive.pipe(Layer.provideMerge(database));
const runtime = ManagedRuntime.make(pipeline);

try {
  await runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* PipelineRunsService;
      type RunId = Parameters<typeof service.updateProgress>[0];
      yield* service.updateProgress(
        ids.m43FailedResurrectionRun as RunId,
        "ingest",
        "progress",
        [],
      );
      yield* service.updateProgress(
        ids.m43CancelledResurrectionRun as RunId,
        "ingest",
        "progress",
        [],
      );
      yield* service.failPreservingProgress(ids.m43CancelledClobberRun as RunId, "late failure");
    }),
  );
} finally {
  await runtime.dispose();
}
