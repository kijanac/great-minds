<script lang="ts">
  import LogOut from "@lucide/svelte/icons/log-out";
  import Moon from "@lucide/svelte/icons/moon";
  import Settings from "@lucide/svelte/icons/settings";
  import Sun from "@lucide/svelte/icons/sun";
  import User from "@lucide/svelte/icons/user";

  import { goto } from "$app/navigation";
  import { auth } from "$lib/auth.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { MENU_ITEM_CLASS, POPOVER_SURFACE_CLASS } from "$lib/control-styles";
  import { theme } from "$lib/theme.svelte";
</script>

{#if auth.isAuthenticated}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="icon-sm"
          aria-label="settings"
          class="rounded-sm text-warm-ghost hover:bg-ink-raised hover:text-warm-faint"
        >
          <Settings class="size-4" />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content
      side="top"
      align="start"
      sideOffset={8}
      class={`w-auto min-w-0 p-1 ${POPOVER_SURFACE_CLASS}`}
    >
      <DropdownMenu.Item
        onclick={() => theme.toggle()}
        class={`${MENU_ITEM_CLASS} cursor-pointer gap-2`}
      >
        {#if theme.current === "dark"}
          <Sun class="size-3.5" />
          light mode
        {:else}
          <Moon class="size-3.5" />
          dark mode
        {/if}
      </DropdownMenu.Item>
      <DropdownMenu.Item
        onclick={() => void goto("/account")}
        class={`${MENU_ITEM_CLASS} cursor-pointer gap-2`}
      >
        <User class="size-3.5" />
        account
      </DropdownMenu.Item>
      <DropdownMenu.Item
        onclick={() => auth.logout()}
        class={`${MENU_ITEM_CLASS} cursor-pointer gap-2`}
      >
        <LogOut class="size-3.5" />
        sign out
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
