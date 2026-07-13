import { createHash } from "node:crypto";

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

/** Mirrors Effect Workflow's private execution-id derivation from an idempotency key. */
export const workflowExecutionId = (workflowName: string, idempotencyKey: string) =>
  createHash("sha256")
    .update(`${workflowName}-${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32);
