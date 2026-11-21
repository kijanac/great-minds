<script lang="ts">
  import { Alert, AlertTitle } from "#lib/components/ui/alert/index.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Skeleton } from "#lib/components/ui/skeleton/index.ts";
  import type { AttentionGroup } from "#lib/hooks/use-attention.svelte.ts";

  const SHOWN = 5;

  let {
    status,
    checking,
    updateGroups,
    adminGroups,
    canUpdate,
    updating,
    updateError,
    onUpdate,
    onRetry,
  }: {
    status: "loading" | "ready" | "unavailable";
    checking: boolean;
    updateGroups: readonly AttentionGroup[];
    adminGroups: readonly AttentionGroup[];
    canUpdate: boolean;
    updating: boolean;
    updateError: string | null;
    onUpdate: () => void;
    onRetry: () => void;
  } = $props();

  let expanded = $state<readonly string[]>([]);
</script>

{#snippet groups(list: readonly AttentionGroup[])}
  {#each list as group (group.label)}
    {@const open = expanded.includes(group.label)}
    <div class="border-t border-ink-subtle pt-4 pb-1">
      <p class="grid grid-cols-[2.5rem_1fr] items-baseline">
        <span class="font-mono text-[length:var(--text-small)] text-gold tabular-nums">
          {group.count}
        </span>
        <span class="font-serif text-[length:var(--text-body)] text-warm">{group.label}</span>
      </p>
      {#if group.items.length > 0}
        <ul class="mt-2.5 ml-10 divide-y divide-ink-subtle">
          {#each open ? group.items : group.items.slice(0, SHOWN) as item, index (index)}
            <li
              class="py-[7px] font-serif text-[length:var(--text-small)] text-warm-dim [overflow-wrap:anywhere]"
            >
              {#if item.href}
                <a href={item.href} class="transition-colors hover:text-gold">{item.text}</a>
              {:else}
                {item.text}
              {/if}
            </li>
          {/each}
        </ul>
        {#if !open && group.items.length > SHOWN}
          <Button
            variant="ghost"
            onclick={() => (expanded = [...expanded, group.label])}
            class="ml-10 h-auto min-h-9 rounded-sm px-0 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-gold-muted hover:bg-transparent hover:text-gold"
          >
            {group.items.length - SHOWN} more
          </Button>
        {/if}
      {/if}
    </div>
  {/each}
{/snippet}

<main class="mx-auto max-w-[740px] px-4 pt-10 pb-24 md:px-10 md:pt-12">
  <h1 class="mb-10 font-serif text-[length:var(--text-title)] leading-tight text-warm">
    Needs attention
  </h1>

  {#if status === "loading"}
    <div class="space-y-3">
      <Skeleton class="h-4 w-40 bg-ink-raised" />
      <Skeleton class="h-10 w-full bg-ink-raised" />
      <Skeleton class="h-10 w-5/6 bg-ink-raised" />
    </div>
  {:else if status === "unavailable"}
    <Alert variant="destructive" class="rounded-sm border-red-400/25 bg-red-400/5 p-5">
      <AlertTitle class="mb-3 font-serif text-[length:var(--text-body)] text-warm-dim">
        Could not check
      </AlertTitle>
      <Button
        variant="ghost"
        size="sm"
        onclick={onRetry}
        disabled={checking}
        class="h-auto rounded-sm px-3 py-1 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold hover:bg-transparent hover:text-gold-hover"
      >
        {checking ? "checking…" : "retry"}
      </Button>
    </Alert>
  {:else if updateGroups.length === 0 && adminGroups.length === 0}
    <p class="font-serif text-[length:var(--text-body)] text-warm-dim">Nothing does.</p>
  {:else}
    <div class="space-y-14">
      {#if updateGroups.length > 0}
        <section>
          <div class="mb-1 flex min-h-9 items-center justify-between gap-4">
            <h2
              class="font-mono text-[length:var(--text-chrome)] tracking-[0.16em] text-gold-muted uppercase"
            >
              The next update fixes
            </h2>
            {#if canUpdate}
              <Button
                variant="outline"
                size="sm"
                onclick={onUpdate}
                disabled={updating}
                class="min-h-9 rounded-sm border-gold-dim font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-gold uppercase hover:bg-gold/10 disabled:opacity-45"
              >
                {updating ? "starting…" : "update"}
              </Button>
            {/if}
          </div>
          {#if updateError}
            <p class="mb-2 font-mono text-[length:var(--text-chrome)] text-destructive">
              {updateError}
            </p>
          {/if}
          {@render groups(updateGroups)}
        </section>
      {/if}
      {#if adminGroups.length > 0}
        <section>
          <div class="mb-1 flex min-h-9 items-center">
            <h2
              class="font-mono text-[length:var(--text-chrome)] tracking-[0.16em] text-gold-muted uppercase"
            >
              An admin has to fix
            </h2>
          </div>
          {@render groups(adminGroups)}
        </section>
      {/if}
    </div>
  {/if}
</main>
