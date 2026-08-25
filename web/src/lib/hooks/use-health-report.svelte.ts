import { createQuery } from "@tanstack/svelte-query";

import { fetchLintResults } from "$lib/api/lint";
import { activeVault } from "$lib/hooks/use-vault.svelte";

export type HealthReportStatus = "loading" | "ready" | "unavailable";

export function useHealthReport() {
  const query = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "health-count"],
    queryFn: fetchLintResults,
    enabled: !!activeVault.id,
  }));

  return {
    get checking() {
      return query.isFetching;
    },
    get count() {
      return (
        (query.data?.orphans.length ?? 0) +
        (query.data?.dirty_topics.length ?? 0) +
        (query.data?.unmentioned_links.length ?? 0)
      );
    },
    get data() {
      return query.data ?? null;
    },
    retry: () => query.refetch(),
    get status(): HealthReportStatus {
      if (query.isError) return "unavailable";
      if (query.data) return "ready";
      return "loading";
    },
  };
}
