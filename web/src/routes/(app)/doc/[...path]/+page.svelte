<script lang="ts">
  import { page } from "$app/state";

  import ArticleReader from "$lib/components/article-reader.svelte";
  import { ErrorState, LoadingState } from "$lib/components/ui/feedback";
  import { useLinkedVault } from "$lib/hooks/use-linked-vault.svelte";

  const path = $derived(page.params.path);
  const linkedVault = useLinkedVault(() => page.url.searchParams.get("vault"));
</script>

<svelte:head>
  <title>Document | Great Minds</title>
</svelte:head>

{#if linkedVault.error}
  <ErrorState message={linkedVault.error} />
{:else if linkedVault.pending}
  <LoadingState label="Opening document…" />
{:else if path}
  {#key `${linkedVault.id}:${path}`}
    <ArticleReader {path} scope="vault" />
  {/key}
{/if}
