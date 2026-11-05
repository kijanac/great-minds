<script lang="ts">
  import type { RunOutcome } from "@great-minds/domain";
  import { QueryClient, setQueryClientContext } from "@tanstack/svelte-query";

  import RunOutcomeView from "./run-outcome.svelte";

  let {
    outcome,
    onOpen,
  }: { outcome: RunOutcome; onOpen: (filePath: string) => void } = $props();
  setQueryClientContext(new QueryClient());
</script>

<RunOutcomeView {outcome} {onOpen} />
