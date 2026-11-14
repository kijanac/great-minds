<script lang="ts">
  import { afterNavigate, goto } from "$app/navigation";
  import type { SessionId } from "@great-minds/domain";

  import HomeContent from "#lib/components/home-content.svelte";
  import { ErrorState, LoadingState } from "#lib/components/ui/feedback/index.ts";
  import { useSavedSession } from "#lib/hooks/use-saved-session.svelte.ts";
  import { useVaults } from "#lib/hooks/use-vault.svelte.ts";

  let {
    sessionId,
    initialQuery,
    origin,
  }: {
    sessionId?: SessionId;
    initialQuery?: string;
    origin?: string;
  } = $props();

  const vaults = useVaults();
  const saved = useSavedSession(() => sessionId ?? null);
  let visit = $state(0);
  let mounted = false;

  afterNavigate(({ shallow, type }) => {
    if (shallow && type === "goto") return;
    if (mounted) visit += 1;
    mounted = true;
  });

  $effect(() => {
    if (vaults.isSuccess && !sessionId && vaults.data.length === 0) {
      void goto("/vaults/new", { replace: true });
    }
  });
</script>

{#if vaults.error}
  <ErrorState message="Couldn't load your vaults." onRetry={() => void vaults.refetch()} />
{:else if vaults.isPending}
  <LoadingState label="Loading…" />
{:else if sessionId && saved.error}
  <ErrorState message="Couldn't load this session." onRetry={() => void saved.refetch()} />
{:else if sessionId && saved.isLoading}
  <LoadingState label="Loading session…" />
{:else}
  {#key `${sessionId ?? "new"}:${visit}`}
    <HomeContent saved={saved.data} {initialQuery} {origin} />
  {/key}
{/if}
