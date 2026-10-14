<script lang="ts">
  import type { SessionId } from "@great-minds/domain";
  import { QueryClient, setQueryClientContext } from "@tanstack/svelte-query";
  import { onMount } from "svelte";
  import SessionExport from "$lib/components/session-export.svelte";
  import { useLinkedVault } from "./use-linked-vault.svelte";
  import { useSessionExport } from "./use-session-export.svelte";
  import { activeVault } from "./use-vault.svelte";

  let {
    sessionId,
    linkedVault = null,
  }: { sessionId: SessionId | null; linkedVault?: string | null } = $props();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  setQueryClientContext(client);
  onMount(() => {
    client.mount();
    const dispose = activeVault.initialize();
    return () => {
      dispose();
      client.unmount();
      client.clear();
    };
  });
  const linked = useLinkedVault(() => linkedVault);
  const publication = useSessionExport(() => sessionId);

  export function navigate(id: SessionId | null, vault: string | null = null) {
    sessionId = id;
    linkedVault = vault;
  }
</script>

<output data-vault={linked.id} data-pending={linked.pending}
  >{linked.error ?? "Ready"}</output
>
<button onclick={publication.prepare}>Export</button>
{#if publication.open}
  <SessionExport
    pending={publication.pending}
    error={publication.error}
    prepared={publication.prepared}
    paper={publication.paper}
    onPrepare={publication.prepare}
    onMarkdown={publication.prepareMarkdown}
    onPaperChange={publication.changePaper}
    onClose={publication.close}
  />
{/if}
