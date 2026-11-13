import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Layer } from "effect";
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine";
import type * as ShardingConfig from "effect/cluster/ShardingConfig";
import * as SingleRunner from "effect/cluster/SingleRunner";

/** Single-node durable workflow engine backed by the application's Postgres. */
export const makeWorkflowEngine = (
  shardingConfig?: Partial<ShardingConfig.ShardingConfig["Service"]>,
) =>
  ClusterWorkflowEngine.layer.pipe(
    Layer.provide(SingleRunner.layer({ runnerStorage: "memory", shardingConfig })),
    Layer.provide(NodeCrypto.layer),
  );

export const WorkflowEngineLive = makeWorkflowEngine();
