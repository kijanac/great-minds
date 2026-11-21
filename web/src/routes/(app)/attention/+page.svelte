<script lang="ts">
  import { goto } from "$app/navigation";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";

  import { requestCompile } from "#lib/api/jobs.ts";
  import { auth } from "#lib/auth.svelte.ts";
  import AttentionContent from "#lib/components/attention-content.svelte";
  import PageHeader from "#lib/components/page-header.svelte";
  import { useAttention } from "#lib/hooks/use-attention.svelte.ts";
  import { useMe } from "#lib/hooks/use-me.svelte.ts";
  import { activeVault, useVaults } from "#lib/hooks/use-vault.svelte.ts";

  const queryClient = useQueryClient();
  const vaults = useVaults();
  const me = useMe();
  const attention = useAttention();
  const vault = $derived(vaults.data?.find((item) => item.id === activeVault.id) ?? null);

  const update = createMutation(() => ({
    mutationFn: () => requestCompile(),
    onSuccess: async (job) => {
      await queryClient.invalidateQueries({ queryKey: ["vault", activeVault.id, "active-job"] });
      await goto(`/pipeline/runs/${job.id}`);
    },
  }));
</script>

<svelte:head>
  <title>Needs attention | Great Minds</title>
</svelte:head>

<div class="flex h-dvh flex-col overflow-hidden">
  <PageHeader title={vault?.name ?? ""} onHome={() => void goto("/")} />

  <div class="min-h-0 flex-1 overflow-y-auto">
    <AttentionContent
      status={attention.status}
      checking={attention.checking}
      updateGroups={attention.updateGroups}
      adminGroups={attention.adminGroups}
      canUpdate={vault?.owner_id === auth.userId && me.canUseModels}
      updating={update.isPending}
      updateError={update.error?.message ?? null}
      onUpdate={() => update.mutate()}
      onRetry={() => void attention.retry()}
    />
  </div>
</div>
