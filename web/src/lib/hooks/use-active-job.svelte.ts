import { createQuery } from "@tanstack/svelte-query";

import { listJobs } from "$lib/api/jobs";
import { activeVault } from "$lib/hooks/use-vault.svelte";

const ACTIVE_STATUSES = new Set(["pending", "running"]);

/** Checks whether there is an active job for the selected vault. */
export function useActiveJob() {
  return createQuery(() => ({
    queryKey: ["vault", activeVault.id, "active-job"],
    queryFn: async () => {
      const page = await listJobs("active");
      return page.items.some((job) => ACTIVE_STATUSES.has(job.status));
    },
    enabled: !!activeVault.id,
    staleTime: 5_000,
  }));
}
