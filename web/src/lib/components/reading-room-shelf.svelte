<script lang="ts">
  import OpenReferenceForm from "$lib/components/open-reference-form.svelte";
  import SourceRow from "$lib/components/source-row.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import type { ReferenceOverview } from "$lib/api/references";

  let {
    items,
    loading,
    error,
    creating,
    createError,
    hasNextPage,
    fetchingNextPage,
    onLoadMore,
    onOpen,
    onOpenExternal,
  }: {
    items: ReferenceOverview[];
    loading: boolean;
    error: string | null;
    creating: boolean;
    createError: string | null;
    hasNextPage: boolean;
    fetchingNextPage: boolean;
    onLoadMore: () => Promise<unknown>;
    onOpen: (reference: ReferenceOverview) => void;
    onOpenExternal: (url: string) => Promise<void>;
  } = $props();
</script>

<OpenReferenceForm
  pending={creating}
  error={createError}
  onOpen={onOpenExternal}
/>

{#if loading && items.length === 0}
  <div class="space-y-3">
    {#each [0, 1, 2, 3] as row (row)}
      <div class="flex items-center justify-between gap-4 px-3 py-2.5">
        <div class="min-w-0 flex-1 space-y-2">
          <Skeleton class="h-5 w-2/3 bg-ink-raised" />
          <Skeleton class="h-3 w-1/2 bg-ink-raised" />
        </div>
        <Skeleton class="h-3 w-16 bg-ink-raised" />
      </div>
    {/each}
  </div>
{:else if error}
  <p
    class="pt-6 text-center font-serif text-[length:var(--text-body)] text-destructive"
  >
    {error}
  </p>
{:else if items.length === 0}
  <div class="pt-6 text-center">
    <p class="mb-2 font-serif text-[length:var(--text-body)] text-warm-dim">
      Your reading room is empty
    </p>
    <p
      class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
    >
      open an external article to keep it here
    </p>
  </div>
{:else}
  <div class="space-y-1">
    {#each items as reference (reference.id)}
      <SourceRow source={reference} onOpen={() => onOpen(reference)} />
    {/each}
  </div>
  {#if hasNextPage}
    <div class="mt-6 text-center">
      <Button
        variant="ghost"
        onclick={() => void onLoadMore()}
        disabled={fetchingNextPage}
        class="h-auto px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:bg-transparent hover:text-gold"
      >
        {fetchingNextPage ? "loading…" : "load more"}
      </Button>
    </div>
  {/if}
{/if}
