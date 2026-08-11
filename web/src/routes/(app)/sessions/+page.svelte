<script lang="ts">
  import { goto } from "$app/navigation";
  import Search from "@lucide/svelte/icons/search";

  import PageHeader from "$lib/components/page-header.svelte";
  import SessionRow from "$lib/components/session-row.svelte";
  import { Button } from "$lib/components/ui/button";
  import { ErrorState } from "$lib/components/ui/feedback";
  import { Input } from "$lib/components/ui/input";
  import { Separator } from "$lib/components/ui/separator";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { useInfiniteSessions } from "$lib/hooks/use-sessions.svelte";

  const query = useInfiniteSessions();
  let filter = $state("");

  const sessions = $derived(
    query.data?.pages.flatMap((page) => page.items) ?? [],
  );
  const filtered = $derived.by(() => {
    const term = filter.trim().toLowerCase();
    return term
      ? sessions.filter((session) => session.query.toLowerCase().includes(term))
      : sessions;
  });
</script>

<svelte:head>
  <title>Sessions | Great Minds</title>
</svelte:head>

<div class="flex h-screen flex-col overflow-hidden">
  {#snippet filterInput()}
    <div class="flex w-full max-w-[300px] items-center gap-2">
      <Search size={14} class="shrink-0 text-muted-foreground" />
      <Input
        bind:value={filter}
        class="h-7 rounded-sm border-ink-border bg-transparent px-3 font-serif text-[length:var(--text-small)] text-foreground caret-gold placeholder:text-input focus-visible:border-gold-dim focus-visible:ring-0 dark:bg-transparent"
        placeholder="Filter..."
      />
    </div>
  {/snippet}
  <PageHeader
    title="sessions"
    trailing={filterInput}
    onHome={() => void goto("/")}
  />

  <div class="min-h-0 flex-1 overflow-y-auto">
    <main class="mx-auto max-w-[740px] px-4 pt-8 pb-20 md:px-10">
      {#if query.error}
        <ErrorState
          message="Couldn't load your sessions."
          onRetry={() => void query.refetch()}
        />
      {:else if query.isLoading}
        <div class="space-y-4">
          {#each [0, 1, 2, 3] as row (row)}
            <div class="space-y-2 px-3 py-3">
              <Skeleton class="h-5 w-3/4 bg-ink-raised" />
              <Skeleton class="h-3 w-24 bg-ink-raised" />
            </div>
          {/each}
        </div>
      {:else if filtered.length === 0 && filter}
        <p class="text-[length:var(--text-body)] text-warm-faint">
          No sessions match your filter.
        </p>
      {:else if filtered.length === 0}
        <div class="pt-8 text-center">
          <p
            class="mb-2 font-serif text-[length:var(--text-body)] text-warm-dim"
          >
            No sessions yet
          </p>
          <p
            class="mb-6 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
          >
            sessions are created when you ask a question from home
          </p>
          <Button
            variant="ghost"
            onclick={() => void goto("/")}
            class="h-auto px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:bg-transparent hover:text-gold"
          >
            go home →
          </Button>
        </div>
      {:else}
        {#each filtered as session, index (session.id)}
          {#if index > 0}
            <Separator class="my-4 bg-ink-subtle" />
          {/if}
          <SessionRow {session} onOpen={(id) => void goto(`/sessions/${id}`)} />
        {/each}

        {#if !filter && query.hasNextPage}
          <div class="mt-6 text-center">
            <Button
              variant="ghost"
              onclick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
              class="h-auto px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:bg-transparent hover:text-gold"
            >
              {query.isFetchingNextPage ? "loading…" : "load more"}
            </Button>
          </div>
        {/if}
      {/if}
    </main>
  </div>
</div>
