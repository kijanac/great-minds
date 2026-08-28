import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";

import { requestCompile } from "$lib/api/jobs";
import { useActiveJob } from "$lib/hooks/use-active-job.svelte";
import { useHealthReport } from "$lib/hooks/use-health-report.svelte";
import { activeVault, useVaults } from "$lib/hooks/use-vault.svelte";
import { loadPanelContent } from "$lib/panel-content";
import type { SourceRef } from "$lib/types";

export function useHealth(selectedCard: () => SourceRef | null) {
  const queryClient = useQueryClient();
  const vaults = useVaults();
  const activeJob = useActiveJob();
  const report = useHealthReport();

  const compileMutation = createMutation(() => ({
    mutationFn: () => requestCompile(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["vault", activeVault.id, "active-job"],
      });
    },
  }));

  const panel = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "article-panel", selectedCard()?.label],
    queryFn: ({ signal }) => loadPanelContent(selectedCard()!, "vault", signal),
    enabled: !!activeVault.id && !!selectedCard(),
  }));

  return {
    get checking() {
      return report.checking;
    },
    get status() {
      return report.status;
    },
    retry: report.retry,
    get currentVault() {
      return vaults.data?.find((vault) => vault.id === activeVault.id) ?? null;
    },
    get dirtyCount() {
      return report.data?.dirty_topics.length ?? 0;
    },
    get hasActivePipeline() {
      return activeJob.data ?? false;
    },
    get missing() {
      return report.data?.unmentioned_links ?? [];
    },
    get orphans() {
      return report.data?.orphans ?? [];
    },
    panel,
    compileMutation,
  };
}
