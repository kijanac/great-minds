<script lang="ts">
  import type { MemberWithEmail, Uuid } from "@great-minds/domain";

  import { errorMessage } from "$lib/api/errors";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { Button } from "$lib/components/ui/button";
  import * as Select from "$lib/components/ui/select";
  import {
    POPOVER_SURFACE_CLASS,
    SELECT_CONTENT_CLASS,
    SELECT_ITEM_CLASS,
  } from "$lib/control-styles";

  let {
    members,
    onTransfer,
  }: {
    members: readonly MemberWithEmail[];
    onTransfer: (userId: Uuid) => Promise<void>;
  } = $props();

  let open = $state(false);
  let selectedId = $state("");
  let transferring = $state(false);
  let error = $state<string | null>(null);
  const candidates = $derived(
    members.filter((member) => member.role !== "owner"),
  );
  const selected = $derived(
    candidates.find((member) => member.user_id === selectedId),
  );

  async function transfer(event: MouseEvent) {
    event.preventDefault();
    if (!selected || transferring) return;
    transferring = true;
    error = null;
    try {
      await onTransfer(selected.user_id);
      open = false;
    } catch (cause) {
      error = errorMessage(cause, "Couldn’t transfer ownership. Try again.");
    } finally {
      transferring = false;
    }
  }
</script>

<AlertDialog.Root
  bind:open
  onOpenChange={(value) => {
    if (value) {
      selectedId = "";
      error = null;
    }
  }}
>
  <AlertDialog.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        disabled={candidates.length === 0}
        class="h-auto rounded-sm px-2 py-2 font-mono text-[length:var(--text-chrome)] text-gold hover:bg-ink-raised hover:text-gold-hover"
      >
        transfer ownership…
      </Button>
    {/snippet}
  </AlertDialog.Trigger>
  <AlertDialog.Content class={POPOVER_SURFACE_CLASS}>
    <AlertDialog.Header>
      <AlertDialog.Title
        class="font-serif text-[length:var(--text-body)] text-warm"
        >Transfer ownership?</AlertDialog.Title
      >
      <AlertDialog.Description
        class="font-mono text-[length:var(--text-chrome)] leading-relaxed text-warm-ghost"
      >
        Choose a member to become the owner of this vault. You will become an
        editor and lose owner privileges. Only the new owner can transfer it
        back.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <Select.Root type="single" bind:value={selectedId} disabled={transferring}>
      <Select.Trigger
        aria-label="New owner"
        class="w-full min-w-0 font-mono text-[length:var(--text-small)] text-warm-dim"
      >
        <span class="truncate">{selected?.email ?? "choose a member"}</span>
      </Select.Trigger>
      <Select.Content class={SELECT_CONTENT_CLASS}>
        {#each candidates as member (member.user_id)}
          <Select.Item
            value={member.user_id}
            label={member.email}
            class={SELECT_ITEM_CLASS}>{member.email}</Select.Item
          >
        {/each}
      </Select.Content>
    </Select.Root>
    {#if error}
      <p
        role="alert"
        class="font-mono text-[length:var(--text-chrome)] text-destructive"
      >
        {error}
      </p>
    {/if}
    <AlertDialog.Footer>
      <AlertDialog.Cancel
        disabled={transferring}
        class="font-mono text-[length:var(--text-chrome)] tracking-[0.08em]"
        >cancel</AlertDialog.Cancel
      >
      <AlertDialog.Action
        disabled={transferring || !selected}
        onclick={transfer}
        class="border border-gold-dim bg-transparent font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold hover:bg-ink-raised disabled:opacity-40"
      >
        {transferring ? "transferring…" : "transfer ownership"}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
