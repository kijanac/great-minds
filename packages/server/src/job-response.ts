import {
  type DrizzleClient,
  pipelineRuns,
  sourceIncarnations,
  type TransactionClient,
  urlIngestRequests,
} from "@great-minds/database";
import type { JobResponse, Uuid } from "@great-minds/domain";
import { eq } from "drizzle-orm";

export const selectJobs = (client: DrizzleClient | TransactionClient) =>
  client
    .select({ run: pipelineRuns, sourceId: sourceIncarnations.sourceId })
    .from(pipelineRuns)
    .leftJoin(urlIngestRequests, eq(urlIngestRequests.id, pipelineRuns.id))
    .leftJoin(sourceIncarnations, eq(sourceIncarnations.id, urlIngestRequests.sourceIncarnationId));

export const jobResponse = ({
  run: row,
  sourceId,
}: {
  readonly run: typeof pipelineRuns.$inferSelect;
  readonly sourceId: Uuid | null;
}): JobResponse => ({
  id: row.id,
  vault_id: row.vaultId,
  trigger: row.trigger,
  source_id: sourceId,
  status: row.status,
  current_phase: row.currentPhase,
  phase_status: row.phaseStatus,
  stages: row.stages,
  warnings: row.warnings,
  error: row.error,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
  completed_at: row.completedAt,
  stream_url: `/jobs/${row.id}/stream`,
});
