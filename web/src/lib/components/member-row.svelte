<script lang="ts">
  import {
    AssignableMemberRole,
    type MemberWithEmail,
  } from "@great-minds/domain";
  import X from "@lucide/svelte/icons/x";
  import { Schema } from "effect";

  import { Button } from "$lib/components/ui/button";
  import * as Select from "$lib/components/ui/select";
  import { SELECT_CONTENT_CLASS, SELECT_ITEM_CLASS } from "$lib/control-styles";

  let {
    member,
    onChangeRole,
    onRemove,
  }: {
    member: MemberWithEmail;
    onChangeRole: (role: AssignableMemberRole) => Promise<void>;
    onRemove: () => Promise<void>;
  } = $props();

  const isAssignableRole = Schema.is(AssignableMemberRole);
</script>

<div
  class="grid grid-cols-[minmax(0,1fr)_6rem_2rem] items-center gap-2 rounded-sm px-3 py-2 hover:bg-ink-raised"
>
  <span
    class="min-w-0 font-mono text-[length:var(--text-small)] break-all text-warm-dim"
    >{member.email}</span
  >
  {#if member.role === "owner"}
    <span
      class="flex h-8 items-center pl-3 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
      >owner</span
    >
  {:else}
    <Select.Root
      type="single"
      value={member.role}
      onValueChange={(role) =>
        isAssignableRole(role) && void onChangeRole(role)}
    >
      <Select.Trigger
        size="sm"
        aria-label={`Role for ${member.email}`}
        class="h-8 w-24 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
      >
        {member.role}
      </Select.Trigger>
      <Select.Content class={SELECT_CONTENT_CLASS}>
        {#each AssignableMemberRole.literals as role (role)}
          <Select.Item value={role} label={role} class={SELECT_ITEM_CLASS}
            >{role}</Select.Item
          >
        {/each}
      </Select.Content>
    </Select.Root>
    <Button
      variant="ghost"
      size="icon"
      onclick={() => void onRemove()}
      aria-label={`remove ${member.email}`}
      class="text-warm-ghost hover:bg-destructive/10 hover:text-destructive"
    >
      <X size={14} />
    </Button>
  {/if}
</div>
