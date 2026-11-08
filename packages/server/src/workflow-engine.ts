import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Layer } from "effect";
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine";
import * as SingleRunner from "effect/cluster/SingleRunner";

/** Single-node durable workflow engine backed by the application's Postgres. */
export const WorkflowEngineLive = ClusterWorkflowEngine.layer.pipe(
  Layer.provide(SingleRunner.layer({ runnerStorage: "memory" })),
  Layer.provide(NodeCrypto.layer),
);
