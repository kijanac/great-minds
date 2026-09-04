<script lang="ts">
  import { page } from "$app/state";
  import { Uuid } from "@great-minds/domain";
  import { Option, Schema } from "effect";

  import PipelineContainer from "$lib/components/pipeline-container.svelte";

  const decodeJobId = Schema.decodeOption(Uuid);
  const routeJobId = $derived(
    page.params.jobId === undefined
      ? null
      : Option.getOrNull(decodeJobId(page.params.jobId)),
  );
</script>

{#if routeJobId}
  <PipelineContainer {routeJobId} />
{/if}
