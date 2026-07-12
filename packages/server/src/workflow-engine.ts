import { Layer } from "effect";
import * as ClusterWorkflowEngine from "effect/unstable/cluster/ClusterWorkflowEngine";
import * as SingleRunner from "effect/unstable/cluster/SingleRunner";

import { PgClientLive } from "./db.ts";

/** Single-node durable workflow engine backed by the application's Postgres. */
export const WorkflowEngineLive = ClusterWorkflowEngine.layer.pipe(
  Layer.provideMerge(
    SingleRunner.layer({ runnerStorage: "memory" }).pipe(Layer.provideMerge(PgClientLive)),
  ),
);
