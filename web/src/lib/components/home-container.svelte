<script lang="ts">
  import { goto } from "$app/navigation";
  import type { SessionId } from "@great-minds/domain";

  import HomeContent from "$lib/components/home-content.svelte";
  import { ErrorState, LoadingState } from "$lib/components/ui/feedback";
  import { useSavedSession } from "$lib/hooks/use-saved-session.svelte";
  import { useVaults } from "$lib/hooks/use-vault.svelte";
  import { sessionOriginHref } from "$lib/session-origin";

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

  $effect(() => {
    if (vaults.isSuccess && !sessionId && vaults.data.length === 0) {
      void goto("/vaults/new", { replaceState: true });
    }
  });

  $effect(() => {
    const data = saved.data;
    const origin = data?.events.find((event) => event.type === "meta")?.origin;
    if (sessionId && data?.kind === "btw" && origin) {
      void goto(sessionOriginHref(origin, sessionId), {
        replaceState: true,
      });
    }
  });
</script>

{#if vaults.error}
  <ErrorState
    message="Couldn't load your vaults."
    onRetry={() => void vaults.refetch()}
  />
{:else if vaults.isPending}
  <LoadingState label="Loading…" />
{:else if sessionId && saved.error}
  <ErrorState
    message="Couldn't load this session."
    onRetry={() => void saved.refetch()}
  />
{:else if sessionId && saved.isLoading}
  <LoadingState label="Loading session…" />
{:else if saved.data?.kind === "btw"}
  <LoadingState label="Opening BTW…" />
{:else}
  {#key sessionId ?? "new"}
    <HomeContent saved={saved.data} {initialQuery} {origin} />
  {/key}
{/if}
