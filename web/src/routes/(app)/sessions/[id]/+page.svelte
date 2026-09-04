<script lang="ts">
  import { page } from "$app/state";
  import { SessionId } from "@great-minds/domain";
  import { Option, Schema } from "effect";

  import HomeContainer from "$lib/components/home-container.svelte";

  const decodeSessionId = Schema.decodeOption(SessionId);
  const sessionId = $derived(
    page.params.id === undefined
      ? null
      : Option.getOrNull(decodeSessionId(page.params.id)),
  );
</script>

<svelte:head>
  <title>Session | Great Minds</title>
</svelte:head>

{#if sessionId}
  <HomeContainer {sessionId} />
{/if}
