<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import X from "@lucide/svelte/icons/x";
  import {
    createInfiniteQuery,
    createMutation,
    useQueryClient,
  } from "@tanstack/svelte-query";

  import {
    createProposal,
    listProposals,
    reviewProposal,
    type ProposalStatus,
  } from "$lib/api/proposals";
  import { nextPageOffset } from "$lib/api/pagination";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Select from "$lib/components/ui/select";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as ToggleGroup from "$lib/components/ui/toggle-group";
  import {
    FILTER_CHIP_CLASS,
    SELECT_CONTENT_CLASS,
    SELECT_ITEM_CLASS,
    SELECT_TRIGGER_CLASS,
  } from "$lib/control-styles";
  import { formatShortDate } from "$lib/utils";

  let {
    vaultId,
    isOwner,
  }: {
    vaultId: string;
    isOwner: boolean;
  } = $props();

  type ProposalFilter = ProposalStatus | "all";
  const PAGE_SIZE = 20;
  const queryClient = useQueryClient();

  let status = $state<ProposalFilter>("pending");
  let showSubmit = $state(false);
  let content = $state("");
  let title = $state("");
  let author = $state("");
  let contentType = $state("texts");

  const proposals = createInfiniteQuery(() => ({
    queryKey: ["proposals", vaultId, status],
    queryFn: ({ pageParam }) =>
      listProposals(vaultId, {
        status: status === "all" ? undefined : status,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => nextPageOffset(lastPage),
    enabled: !!vaultId,
  }));

  const create = createMutation(() => ({
    mutationFn: (input: {
      content: string;
      content_type: string;
      title?: string;
      author?: string;
    }) => createProposal(vaultId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["proposals", vaultId],
      });
    },
  }));

  const review = createMutation(() => ({
    mutationFn: ({
      proposalId,
      nextStatus,
    }: {
      proposalId: string;
      nextStatus: "approved" | "rejected";
    }) => reviewProposal(vaultId, proposalId, nextStatus),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["proposals", vaultId],
      });
    },
  }));

  const items = $derived(
    proposals.data?.pages.flatMap((page) => page.items) ?? [],
  );

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const body = content.trim();
    if (!body || create.isPending) return;
    await create.mutateAsync({
      content: body,
      content_type: contentType,
      title: title.trim() || undefined,
      author: author.trim() || undefined,
    });
    content = "";
    title = "";
    author = "";
    showSubmit = false;
  }

  function proposalTypeLabel(value: string): string {
    return value === "source_deletion" ? "delete source" : value;
  }
</script>

<section class="mt-12">
  <h2
    class="mb-4 font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
  >
    proposals
  </h2>

  <ToggleGroup.Root
    type="single"
    bind:value={status}
    variant="outline"
    size="sm"
    class="mb-4"
  >
    {#each ["pending", "approved", "rejected", "all"] as value (value)}
      <ToggleGroup.Item {value} class={FILTER_CHIP_CLASS}
        >{value}</ToggleGroup.Item
      >
    {/each}
  </ToggleGroup.Root>

  {#if proposals.isLoading && items.length === 0}
    <p
      class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
    >
      loading…
    </p>
  {:else if items.length === 0}
    <p
      class="mb-4 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
    >
      no proposals
    </p>
  {:else}
    <div class="mb-4 space-y-1">
      {#each items as proposal (proposal.id)}
        <div
          class="group flex items-center justify-between rounded-sm px-3 py-2 hover:bg-ink-raised"
        >
          <div class="flex min-w-0 flex-1 flex-col items-start gap-0.5">
            <span
              class="w-full truncate text-left font-serif text-[length:var(--text-body)] text-warm-dim transition-colors group-hover:text-warm"
            >
              {proposal.title || "(untitled)"}
            </span>
            <span
              class="w-full truncate text-left font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost"
            >
              {proposalTypeLabel(proposal.content_type)} · {proposal.status}
            </span>
          </div>
          <div class="ml-4 flex shrink-0 items-center gap-3">
            <span
              class="font-mono text-[length:var(--text-chrome)] text-warm-ghost"
            >
              {formatShortDate(proposal.created_at)}
            </span>
            {#if isOwner && proposal.status === "pending"}
              <div class="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onclick={() =>
                    review.mutate({
                      proposalId: proposal.id,
                      nextStatus: "approved",
                    })}
                  disabled={review.isPending}
                  aria-label="approve"
                  class="text-warm-ghost hover:bg-transparent hover:text-gold"
                >
                  <Check size={12} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onclick={() =>
                    review.mutate({
                      proposalId: proposal.id,
                      nextStatus: "rejected",
                    })}
                  disabled={review.isPending}
                  aria-label="reject"
                  class="text-warm-ghost hover:bg-transparent hover:text-red-400"
                >
                  <X size={12} />
                </Button>
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if proposals.hasNextPage && !proposals.isFetchingNextPage}
    <div class="mb-4 text-center">
      <Button
        variant="ghost"
        onclick={() => void proposals.fetchNextPage()}
        class="h-auto px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold-muted hover:bg-transparent hover:text-gold"
      >
        load more
      </Button>
    </div>
  {/if}

  {#if showSubmit}
    <form onsubmit={submit} class="mt-4 space-y-3">
      <div class="flex flex-col gap-3 sm:flex-row">
        <Input
          bind:value={title}
          placeholder="title (optional)"
          disabled={create.isPending}
          class="h-8 flex-1 rounded-sm border-ink-border bg-transparent px-3 font-mono text-[length:var(--text-small)] text-warm caret-gold placeholder:text-warm-ghost focus-visible:border-gold-dim focus-visible:ring-0 dark:bg-transparent"
        />
        <Input
          bind:value={author}
          placeholder="author (optional)"
          disabled={create.isPending}
          class="h-8 flex-1 rounded-sm border-ink-border bg-transparent px-3 font-mono text-[length:var(--text-small)] text-warm caret-gold placeholder:text-warm-ghost focus-visible:border-gold-dim focus-visible:ring-0 dark:bg-transparent"
        />
        <Select.Root
          type="single"
          bind:value={contentType}
          disabled={create.isPending}
        >
          <Select.Trigger size="sm" class={`h-8 ${SELECT_TRIGGER_CLASS}`}>
            {contentType}
          </Select.Trigger>
          <Select.Content class={SELECT_CONTENT_CLASS}>
            {#each ["texts", "news", "ideas"] as value (value)}
              <Select.Item {value} label={value} class={SELECT_ITEM_CLASS}>
                {value}
              </Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <Textarea
        bind:value={content}
        placeholder="paste source content here"
        disabled={create.isPending}
        rows={6}
        class="min-h-[120px] rounded-sm font-serif text-[length:var(--text-body)] text-foreground caret-gold placeholder:text-warm-ghost focus-visible:ring-0"
      />
      <div class="flex items-center gap-3">
        <Button
          type="submit"
          disabled={!content.trim() || create.isPending}
          class="rounded-sm border border-gold-dim bg-gold/15 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold hover:bg-gold/25"
        >
          {create.isPending ? "submitting…" : "submit proposal"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onclick={() => (showSubmit = false)}
          disabled={create.isPending}
          class="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost hover:bg-transparent hover:text-warm"
        >
          cancel
        </Button>
      </div>
    </form>
  {:else}
    <Button
      variant="ghost"
      onclick={() => (showSubmit = true)}
      class="font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-faint hover:bg-transparent hover:text-gold"
    >
      + propose a source
    </Button>
  {/if}
</section>
