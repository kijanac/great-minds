import { useQuery } from "@tanstack/react-query";

import { getCurrentPipeline } from "@/api/pipelines";
import { useActiveVaultId } from "@/hooks/use-vault";

const ACTIVE_STATUSES = new Set(["pending", "running"]);

/** Checks whether there's an active pipeline run for the current vault. */
export function useActivePipeline(): boolean {
  const vaultId = useActiveVaultId();

  const { data } = useQuery({
    queryKey: ["vault", vaultId, "active-pipeline"],
    queryFn: async () => {
      const run = await getCurrentPipeline();
      return run !== null && ACTIVE_STATUSES.has(run.status);
    },
    enabled: !!vaultId,
    staleTime: 5_000,
  });

  return data ?? false;
}
