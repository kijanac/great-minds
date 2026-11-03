<script lang="ts">
  import type { Uuid } from "@great-minds/domain";
  import { QueryClient, setQueryClientContext } from "@tanstack/svelte-query";
  import { useJobSSE } from "./use-job-sse.svelte";

  let { jobId, vaultId }: { jobId: Uuid; vaultId: Uuid } = $props();
  setQueryClientContext(new QueryClient());
  const progress = useJobSSE(
    () => jobId,
    () => vaultId,
  );
</script>

<output
  data-done={progress.overallDone}
  data-error={progress.overallError ?? ""}
  data-stream-error={progress.streamError ?? ""}
></output>
<button onclick={() => progress.reconnect()}>reconnect</button>
