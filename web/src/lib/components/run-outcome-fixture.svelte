<script lang="ts">
  import type { RunOutcome } from "@great-minds/domain";
  import { QueryClient, setQueryClientContext } from "@tanstack/svelte-query";

  import RunOutcomeView from "./run-outcome.svelte";

  let {
    outcome,
    onOpen,
    stopped = null,
  }: {
    outcome: RunOutcome | null;
    onOpen: (filePath: string) => void;
    stopped?: {
      readonly kind: "failed" | "cancelled";
      readonly stage: string | null;
    } | null;
  } = $props();
  setQueryClientContext(new QueryClient());
</script>

<RunOutcomeView {outcome} {onOpen} {stopped} />
