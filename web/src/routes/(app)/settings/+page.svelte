<script lang="ts">
  import { goto } from "$app/navigation";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Home from "@lucide/svelte/icons/home";
  import Plus from "@lucide/svelte/icons/plus";

  import ApiKeysSection from "$lib/components/api-keys-section.svelte";
  import PasskeysSection from "$lib/components/passkeys-section.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { activeVault, useVaults } from "$lib/hooks/use-vault.svelte";
  import { formatShortDate } from "$lib/utils";

  const vaults = useVaults();
  const list = $derived(vaults.data ?? []);
</script>

<svelte:head>
  <title>Settings | Great Minds</title>
</svelte:head>

<div class="flex h-screen flex-col overflow-hidden">
  <div
    class="flex shrink-0 items-center gap-4 border-b border-ink-subtle px-4 pt-4 pb-3 md:px-6"
  >
    <Button
      variant="ghost"
      size="icon-xs"
      onclick={() => void goto("/")}
      class="text-muted-foreground hover:bg-transparent hover:text-gold"
      aria-label="home"
    >
      <Home size={14} />
    </Button>
    <span
      class="hidden font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase md:inline"
    >
      settings
    </span>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto max-w-[740px] px-4 pt-8 pb-20 md:px-10">
      <section>
        <div class="mb-4 flex items-center justify-between gap-4">
          <h2
            class="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
          >
            vaults
          </h2>
          <Button
            variant="ghost"
            onclick={() => void goto("/vaults/new")}
            class="h-auto gap-2 rounded-sm px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint hover:bg-ink-raised hover:text-gold"
          >
            <Plus class="size-3" />
            new vault
          </Button>
        </div>

        {#if vaults.isLoading}
          <div class="space-y-1">
            <Skeleton class="h-10 w-full bg-ink-raised" />
            <Skeleton class="h-10 w-full bg-ink-raised" />
          </div>
        {:else if list.length === 0}
          <p
            class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
          >
            no vaults yet
          </p>
        {:else}
          <div class="space-y-1">
            {#each list as vault (vault.id)}
              <Button
                variant="ghost"
                onclick={() => void goto(`/vaults/${vault.id}/settings`)}
                class="group h-auto w-full justify-between gap-4 rounded-sm px-3 py-2 hover:bg-ink-raised"
              >
                <span class="flex min-w-0 items-baseline gap-3">
                  <span
                    class="truncate font-serif text-[length:var(--text-body)] text-warm"
                  >
                    {vault.name}
                  </span>
                  {#if vault.id === activeVault.id}
                    <span
                      class="shrink-0 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold-muted"
                    >
                      current
                    </span>
                  {/if}
                </span>
                <span
                  class="flex shrink-0 items-center gap-2 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost group-hover:text-warm-faint"
                >
                  {formatShortDate(vault.created_at)}
                  <ChevronRight size={11} />
                </span>
              </Button>
            {/each}
          </div>
        {/if}
      </section>

      <PasskeysSection />
      <ApiKeysSection />
    </div>
  </div>
</div>
