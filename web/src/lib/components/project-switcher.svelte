<script lang="ts">
  import { goto } from "$app/navigation";
  import ArrowLeftRight from "@lucide/svelte/icons/arrow-left-right";
  import Check from "@lucide/svelte/icons/check";
  import Plus from "@lucide/svelte/icons/plus";
  import Settings from "@lucide/svelte/icons/settings";

  import { Button } from "$lib/components/ui/button";
  import * as Popover from "$lib/components/ui/popover";
  import { MENU_ITEM_CLASS, POPOVER_SURFACE_CLASS } from "$lib/control-styles";
  import {
    activeVault,
    switchVault,
    useVaults,
  } from "$lib/hooks/use-vault.svelte";

  const vaults = useVaults();
  let open = $state(false);

  const list = $derived(vaults.data ?? []);
  const isEmpty = $derived(list.length === 0);
  const triggerLabel = $derived(isEmpty ? "new project" : "switch project");

  function createProject() {
    open = false;
    void goto("/vaults/new");
  }

  function chooseVault(vaultId: string) {
    if (vaultId !== activeVault.id) {
      switchVault(vaultId);
      void goto("/");
    }
    open = false;
  }

  function openSettings(vaultId: string) {
    open = false;
    void goto(`/project/${vaultId}/settings`);
  }
</script>

{#if !vaults.isLoading}
  {#if isEmpty}
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={triggerLabel}
      onclick={createProject}
      class="rounded-sm text-warm-ghost hover:bg-ink-raised hover:text-warm-faint"
    >
      <Plus class="size-3.5" />
    </Button>
  {:else}
    <Popover.Root bind:open>
      <Popover.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="ghost"
            size="icon-sm"
            aria-label={triggerLabel}
            class="rounded-sm text-warm-ghost hover:bg-ink-raised hover:text-warm-faint"
          >
            <ArrowLeftRight class="size-3.5" />
          </Button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content
        side="bottom"
        align="end"
        sideOffset={8}
        class={`w-auto min-w-[220px] p-1 ${POPOVER_SURFACE_CLASS}`}
      >
        {#each list as vault (vault.id)}
          <div class="group flex items-center">
            <Button
              variant="ghost"
              size="sm"
              onclick={() => chooseVault(vault.id)}
              class={`${MENU_ITEM_CLASS} flex-1 justify-start gap-2`}
            >
              {#if vault.id === activeVault.id}
                <Check class="size-3.5" />
              {:else}
                <span class="size-3.5"></span>
              {/if}
              {vault.name}
            </Button>
            {#if vault.id === activeVault.id}
              <Button
                variant="ghost"
                size="icon-xs"
                onclick={() => openSettings(vault.id)}
                aria-label="project settings"
                class="mr-1 text-warm-ghost opacity-0 transition-opacity group-hover:opacity-100 hover:bg-transparent hover:text-gold focus-visible:opacity-100"
              >
                <Settings size={11} />
              </Button>
            {/if}
          </div>
        {/each}
        <div class="my-1 border-t border-ink-border"></div>
        <Button
          variant="ghost"
          size="sm"
          onclick={createProject}
          class={`${MENU_ITEM_CLASS} w-full justify-start gap-2`}
        >
          <Plus class="size-3.5" />
          new project
        </Button>
      </Popover.Content>
    </Popover.Root>
  {/if}
{/if}
