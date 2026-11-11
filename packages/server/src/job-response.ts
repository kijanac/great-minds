import { pipelineRuns } from "@great-minds/database";
import type { JobResponse } from "@great-minds/domain";

export const jobResponse = (row: typeof pipelineRuns.$inferSelect): JobResponse => ({
  id: row.id,
  vault_id: row.vaultId,
  trigger: row.trigger,
  status: row.status,
  current_phase: row.currentPhase,
  phase_status: row.phaseStatus,
  stages: row.stages,
  warnings: row.warnings,
  error: row.error,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
  completed_at: row.completedAt,
});
