import { useQuery } from "@tanstack/react-query";

import { listTasks } from "@/api/ingest";
import { useActiveVaultId } from "@/hooks/use-vault";

const ACTIVE_STATUSES = new Set(["pending", "running"]);

/**
 * Checks whether there's an active compile or bulk ingest pipeline
 * for the current vault. Polls the tasks endpoint every 10 seconds.
 */
export function useActivePipeline(): boolean {
  const vaultId = useActiveVaultId();

  const { data } = useQuery({
    queryKey: ["vault", vaultId, "active-pipeline"],
    queryFn: async () => {
      const tasks = await listTasks(10);
      return tasks.some(
        (t) =>
          ACTIVE_STATUSES.has(t.status) &&
          (t.type === "compile" || t.type === "bulk_ingest_from_staging"),
      );
    },
    enabled: !!vaultId,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  return data ?? false;
}
