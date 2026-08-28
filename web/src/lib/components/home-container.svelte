<script lang="ts">
  import { goto } from "$app/navigation";

  import HomeContent from "$lib/components/home-content.svelte";
  import { ErrorState, LoadingState } from "$lib/components/ui/feedback";
  import { useSavedSession } from "$lib/hooks/use-saved-session.svelte";
  import { useVaults } from "$lib/hooks/use-vault.svelte";

  let {
    sessionId,
    initialQuery,
    origin,
  }: {
    sessionId?: string;
    initialQuery?: string;
    origin?: string;
  } = $props();

  const vaults = useVaults();
  const saved = useSavedSession(() => sessionId ?? null);

  $effect(() => {
    if (!vaults.isLoading && !sessionId && (vaults.data?.length ?? 0) === 0) {
      void goto("/vaults/new", { replaceState: true });
    }
  });
</script>

{#if vaults.error}
  <ErrorState
    message="Couldn't load your vaults."
    onRetry={() => void vaults.refetch()}
  />
{:else if vaults.isLoading}
  <LoadingState label="Loading…" />
{:else if sessionId && saved.error}
  <ErrorState
    message="Couldn't load this session."
    onRetry={() => void saved.refetch()}
  />
{:else if sessionId && saved.isLoading}
  <LoadingState label="Loading session…" />
{:else}
  <HomeContent
    {sessionId}
    initialExchanges={saved.data?.exchanges ?? undefined}
    sessionOrigin={saved.data?.origin ?? null}
    originTitle={saved.data?.originTitle ?? null}
    {initialQuery}
    {origin}
  />
{/if}
