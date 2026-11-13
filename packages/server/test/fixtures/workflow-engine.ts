import { Duration } from "effect";

import { makeWorkflowEngine } from "../../src/workflow-engine.ts";

export const TestWorkflowEngineLive = makeWorkflowEngine({
  entityTerminationTimeout: Duration.millis(100),
});
