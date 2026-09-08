import { pipelineRuns } from "@great-minds/database";
import { JobResponse } from "@great-minds/domain";
import { Schema } from "effect";

export const jobState = Schema.decodeUnknownSync(Schema.Struct({
  trigger: JobResponse.fields.trigger,
  status: JobResponse.fields.status,
  progressSteps: JobResponse.fields.progress_steps,
}));

export const jobResponse = (row: typeof pipelineRuns.$inferSelect): JobResponse => {
  const state = jobState(row);
  return {
    id: row.id,
    vault_id: row.vaultId,
    trigger: state.trigger,
    status: state.status,
    current_phase: row.currentPhase,
    phase_status: row.phaseStatus,
    progress_steps: state.progressSteps,
    error: row.error,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    completed_at: row.completedAt,
    stream_url: `/jobs/${row.id}/stream`,
  };
};
