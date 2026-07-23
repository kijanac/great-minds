<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Copy from "@lucide/svelte/icons/copy";
  import X from "@lucide/svelte/icons/x";
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";

  import { createApiKey, listApiKeys, revokeApiKey } from "$lib/api/api-keys";
  import { Button } from "$lib/components/ui/button";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { Input } from "$lib/components/ui/input";
  import { formatShortDate } from "$lib/utils";

  const queryClient = useQueryClient();
  const keysQuery = createQuery(() => ({
    queryKey: ["api-keys"],
    queryFn: listApiKeys,
  }));
  const create = createMutation(() => ({
    mutationFn: createApiKey,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  }));
  const revoke = createMutation(() => ({
    mutationFn: revokeApiKey,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  }));

  let label = $state("");
  let copied = $state(false);
  let revokedOpen = $state(false);

  const keys = $derived(keysQuery.data ?? []);
  const active = $derived(keys.filter((key) => !key.revoked));
  const revoked = $derived(keys.filter((key) => key.revoked));

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const value = label.trim();
    if (!value || create.isPending) return;
    await create.mutateAsync(value);
    label = "";
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    copied = true;
    window.setTimeout(() => (copied = false), 1500);
  }
</script>

<section class="mt-12">
  <h2
    class="mb-4 font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
  >
    api keys
  </h2>

  {#if create.data}
    <div class="mb-6 rounded-sm border border-gold-dim bg-gold/10 p-4">
      <div class="mb-3 flex items-start justify-between gap-3">
        <div
          class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-gold"
        >
          new key — copy now, it won't be shown again
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onclick={() => create.reset()}
          aria-label="dismiss new key"
          class="shrink-0 text-warm-ghost hover:text-warm"
        >
          <X size={12} />
        </Button>
      </div>
      <div class="flex items-center gap-2">
        <code
          class="flex-1 break-all rounded-sm bg-ink-raised px-3 py-2 font-mono text-[length:var(--text-small)] text-warm"
        >
          {create.data.raw_key}
        </code>
        <Button
          variant="ghost"
          size="icon-sm"
          onclick={() => void copy(create.data!.raw_key)}
          class="shrink-0 text-warm-ghost hover:text-gold"
          aria-label="copy"
        >
          {#if copied}
            <Check size={14} />
          {:else}
            <Copy size={14} />
          {/if}
        </Button>
      </div>
    </div>
  {/if}

  {#if keysQuery.isLoading && keys.length === 0}
    <p
      class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
    >
      loading…
    </p>
  {:else if keys.length === 0}
    <p
      class="mb-4 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
    >
      no api keys yet
    </p>
  {:else}
    <div class="mb-4 space-y-1">
      {#each active as key (key.id)}
        <div
          class="group flex items-center justify-between rounded-sm px-3 py-2 hover:bg-ink-raised"
        >
          <span
            class="truncate font-mono text-[length:var(--text-small)] text-warm-dim"
          >
            {key.label}
          </span>
          <div class="flex items-center gap-3">
            <span
              class="shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
            >
              {formatShortDate(key.created_at)}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onclick={() => revoke.mutate(key.id)}
              disabled={revoke.isPending}
              class="text-warm-ghost opacity-0 transition-opacity group-hover:opacity-100 hover:bg-transparent hover:text-red-400 focus-visible:opacity-100"
              aria-label="revoke"
            >
              <X size={12} />
            </Button>
          </div>
        </div>
      {/each}

      {#if revoked.length > 0}
        <Collapsible.Root bind:open={revokedOpen} class="mt-2">
          <Collapsible.Trigger
            class="flex h-auto items-center gap-1 rounded-none p-0 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost hover:text-warm-faint"
          >
            {#if revokedOpen}
              <ChevronDown size={10} />
            {:else}
              <ChevronRight size={10} />
            {/if}
            {revoked.length} revoked
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div class="mt-1 space-y-1">
              {#each revoked as key (key.id)}
                <div
                  class="flex items-center justify-between rounded-sm px-3 py-2 opacity-60"
                >
                  <span
                    class="truncate font-mono text-[length:var(--text-small)] text-warm-ghost line-through"
                  >
                    {key.label}
                  </span>
                  <span
                    class="shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
                  >
                    {formatShortDate(key.created_at)}
                  </span>
                </div>
              {/each}
            </div>
          </Collapsible.Content>
        </Collapsible.Root>
      {/if}
    </div>
  {/if}

  <form onsubmit={submit} class="flex items-center gap-3">
    <Input
      bind:value={label}
      placeholder="new key label"
      disabled={create.isPending}
      class="h-8 rounded-sm border-ink-border bg-transparent px-3 font-mono text-[length:var(--text-small)] text-warm caret-gold placeholder:text-warm-ghost focus-visible:border-gold-dim focus-visible:ring-0 dark:bg-transparent"
    />
    <span
      class="shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
    >
      ↵
    </span>
  </form>
</section>
