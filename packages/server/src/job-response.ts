import { pipelineRuns } from "@great-minds/database";
import type { JobResponse, Uuid } from "@great-minds/domain";

export const jobResponse = (row: typeof pipelineRuns.$inferSelect): JobResponse => ({
  id: row.id as Uuid,
  vault_id: row.vaultId as Uuid,
  trigger: row.trigger as JobResponse["trigger"],
  status: row.status as JobResponse["status"],
  current_phase: row.currentPhase,
  phase_status: row.phaseStatus,
  progress_steps: row.progressSteps as JobResponse["progress_steps"],
  error: row.error,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
  completed_at: row.completedAt?.toISOString() ?? null,
  stream_url: `/jobs/${row.id}/stream`,
});
