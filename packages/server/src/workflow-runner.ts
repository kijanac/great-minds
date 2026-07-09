import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Redacted } from "effect";

type WorkflowRow = {
  workflow_id: string;
  prepare_done: boolean;
  finish_done: boolean;
};

const safeLocalDatabaseUrl = () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the workflow durability check");
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

const workflowId = process.env.SPIKE_WORKFLOW_ID ?? "spike-zero-demo";

const program = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS spike_workflow_checkpoints (
      workflow_id text PRIMARY KEY,
      prepare_done boolean NOT NULL DEFAULT false,
      finish_done boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  yield* sql`
    INSERT INTO spike_workflow_checkpoints (workflow_id)
    VALUES (${workflowId})
    ON CONFLICT (workflow_id) DO NOTHING
  `;

  const [row] = yield* sql<WorkflowRow>`
    SELECT workflow_id, prepare_done, finish_done
    FROM spike_workflow_checkpoints
    WHERE workflow_id = ${workflowId}
  `;

  if (!row) {
    throw new Error("Workflow row was not created");
  }

  console.log(
    `[workflow] loaded id=${row.workflow_id} prepare_done=${row.prepare_done} finish_done=${row.finish_done}`
  );

  if (!row.prepare_done) {
    console.log("[workflow] step=prepare starting slow checkpointed work");
    yield* Effect.sleep("1 second");
    yield* sql`
      UPDATE spike_workflow_checkpoints
      SET prepare_done = true, updated_at = now()
      WHERE workflow_id = ${workflowId}
    `;
    console.log("[workflow] checkpoint saved step=prepare");

    if (process.env.SPIKE_KILL_AFTER_CHECKPOINT === "1") {
      console.log("[workflow] SIGKILL requested after first checkpoint");
      process.kill(process.pid, "SIGKILL");
    }
  } else {
    console.log("[workflow] resuming from checkpoint: step=prepare already complete");
  }

  const [afterPrepare] = yield* sql<WorkflowRow>`
    SELECT workflow_id, prepare_done, finish_done
    FROM spike_workflow_checkpoints
    WHERE workflow_id = ${workflowId}
  `;

  if (!afterPrepare?.finish_done) {
    console.log("[workflow] step=finish starting");
    yield* Effect.sleep("1 second");
    yield* sql`
      UPDATE spike_workflow_checkpoints
      SET finish_done = true, updated_at = now()
      WHERE workflow_id = ${workflowId}
    `;
    console.log("[workflow] checkpoint saved step=finish");
  } else {
    console.log("[workflow] step=finish already complete");
  }

  console.log(`[workflow] completed id=${workflowId}`);
});

await Effect.runPromise(
  program.pipe(
    Effect.provide(PgClient.layer({ url: Redacted.make(safeLocalDatabaseUrl()) })),
    Effect.scoped
  )
);
