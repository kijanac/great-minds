<script lang="ts">
  import Crown from "@lucide/svelte/icons/crown";
  import X from "@lucide/svelte/icons/x";

  import type { Membership } from "$lib/api/vaults";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { Button } from "$lib/components/ui/button";
  import * as Select from "$lib/components/ui/select";
  import {
    POPOVER_SURFACE_CLASS,
    SELECT_CONTENT_CLASS,
    SELECT_ITEM_CLASS,
  } from "$lib/control-styles";

  let {
    member,
    isOwner,
    onChangeRole,
    onRemove,
    onTransfer,
  }: {
    member: Membership;
    isOwner: boolean;
    onChangeRole: (role: string) => Promise<void>;
    onRemove: () => Promise<void>;
    onTransfer: () => Promise<void>;
  } = $props();

  let transferOpen = $state(false);
  let transferring = $state(false);
  let error = $state<string | null>(null);

  async function transfer() {
    if (transferring) return;
    transferring = true;
    error = null;
    try {
      await onTransfer();
      transferOpen = false;
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "Failed to transfer ownership.";
    } finally {
      transferring = false;
    }
  }
</script>

<div
  class="group flex items-center justify-between rounded-sm px-3 py-2 hover:bg-ink-raised"
>
  <span
    class="truncate font-mono text-[length:var(--text-small)] text-warm-dim"
  >
    {member.email}
  </span>
  <div class="flex items-center gap-2">
    {#if isOwner && member.role !== "owner"}
      <Select.Root
        type="single"
        value={member.role}
        onValueChange={(role) => role && void onChangeRole(role)}
      >
        <Select.Trigger
          size="sm"
          class="h-8 w-24 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
        >
          {member.role}
        </Select.Trigger>
        <Select.Content class={SELECT_CONTENT_CLASS}>
          {#each ["editor", "viewer"] as role (role)}
            <Select.Item value={role} label={role} class={SELECT_ITEM_CLASS}>
              {role}
            </Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    {:else}
      <span
        class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
      >
        {member.role}
      </span>
    {/if}

    {#if isOwner && member.role !== "owner"}
      <AlertDialog.Root bind:open={transferOpen}>
        <AlertDialog.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="icon-xs"
              aria-label={`transfer ownership to ${member.email}`}
              class="text-warm-ghost opacity-0 transition-opacity group-hover:opacity-100 hover:bg-transparent hover:text-gold focus-visible:opacity-100"
            >
              <Crown size={12} />
            </Button>
          {/snippet}
        </AlertDialog.Trigger>
        <AlertDialog.Content class={POPOVER_SURFACE_CLASS}>
          <AlertDialog.Header>
            <AlertDialog.Title
              class="font-serif text-[length:var(--text-body)] text-warm"
            >
              Transfer ownership?
            </AlertDialog.Title>
            <AlertDialog.Description
              class="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost"
            >
              Make <span class="text-gold">{member.email}</span> the owner of this
              vault. You will become an editor and lose owner privileges; only the
              new owner can transfer it back.
            </AlertDialog.Description>
          </AlertDialog.Header>
          {#if error}
            <Alert
              variant="destructive"
              class="rounded-sm border-red-400/25 bg-red-400/5"
            >
              <AlertDescription
                class="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-red-400/90"
              >
                {error}
              </AlertDescription>
            </Alert>
          {/if}
          <AlertDialog.Footer>
            <AlertDialog.Cancel
              disabled={transferring}
              class="font-mono text-[length:var(--text-chrome)] tracking-[0.08em]"
            >
              cancel
            </AlertDialog.Cancel>
            <AlertDialog.Action
              disabled={transferring}
              onclick={(event) => {
                event.preventDefault();
                void transfer();
              }}
              class="border border-gold-dim font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold hover:bg-ink-raised disabled:opacity-40"
            >
              {transferring ? "transferring…" : "transfer ownership"}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>

      <Button
        variant="ghost"
        size="icon-xs"
        onclick={() => void onRemove()}
        aria-label={`remove ${member.email}`}
        class="text-warm-ghost opacity-0 transition-opacity group-hover:opacity-100 hover:bg-transparent hover:text-red-400 focus-visible:opacity-100"
      >
        <X size={12} />
      </Button>
    {/if}
  </div>
</div>
