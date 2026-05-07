import { useQuery } from "@tanstack/react-query";

import { listJobs } from "@/api/jobs";
import { useActiveVaultId } from "@/hooks/use-vault";

const ACTIVE_STATUSES = new Set(["pending", "running"]);

/** Checks whether there's an active job for the current vault. */
export function useActiveJob(): boolean {
  const vaultId = useActiveVaultId();

  const { data } = useQuery({
    queryKey: ["vault", vaultId, "active-job"],
    queryFn: async () => {
      const page = await listJobs("active");
      return page.items.some((job) => ACTIVE_STATUSES.has(job.status));
    },
    enabled: !!vaultId,
    staleTime: 5_000,
  });

  return data ?? false;
}
