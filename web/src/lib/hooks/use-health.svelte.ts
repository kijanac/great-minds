import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";

import { compile } from "$lib/api/compile";
import { fetchLintResults } from "$lib/api/lint";
import { useActiveJob } from "$lib/hooks/use-active-job.svelte";
import { activeVault, useVaults } from "$lib/hooks/use-vault.svelte";
import { loadPanelContent } from "$lib/panel-content";
import type { SourceRef } from "$lib/types";

export function useHealth(selectedCard: () => SourceRef | null) {
  const queryClient = useQueryClient();
  const vaults = useVaults();
  const activeJob = useActiveJob();

  const lint = createQuery(() => ({
    queryKey: ["vault", activeVault.id, "health-count"],
    queryFn: fetchLintResults,
    enabled: !!activeVault.id,
  }));

  const compileMutation = createMutation(() => ({
    mutationFn: () => compile(),
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
    get currentVault() {
      return vaults.data?.find((vault) => vault.id === activeVault.id) ?? null;
    },
    get dirtyCount() {
      return lint.data?.dirty_topics.length ?? 0;
    },
    get hasActivePipeline() {
      return activeJob.data ?? false;
    },
    get loading() {
      return lint.isLoading;
    },
    get missing() {
      return lint.data?.unmentioned_links ?? [];
    },
    get orphans() {
      return lint.data?.orphans ?? [];
    },
    panel,
    compileMutation,
  };
}
