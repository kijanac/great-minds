<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";

  import {
    deleteVault,
    getVaultConfig,
    getVaultDetail,
    inviteMember,
    listMembers,
    removeMember,
    transferOwnership,
    updateMemberRole,
    updateVaultConfig,
  } from "$lib/api/vaults";
  import { auth } from "$lib/auth.svelte";
  import MemberRow from "$lib/components/member-row.svelte";
  import PageHeader from "$lib/components/page-header.svelte";
  import ProposalsSection from "$lib/components/proposals-section.svelte";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Select from "$lib/components/ui/select";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import VaultConfigForm, {
    type VaultConfigFormSubmit,
  } from "$lib/components/vault-config-form.svelte";
  import {
    POPOVER_SURFACE_CLASS,
    SELECT_CONTENT_CLASS,
    SELECT_ITEM_CLASS,
  } from "$lib/control-styles";

  const vaultId = $derived(page.params.id ?? "");
  const queryClient = useQueryClient();

  let email = $state("");
  let inviteRole = $state("editor");
  let invitePending = $state(false);
  let savePending = $state(false);
  let deleteOpen = $state(false);
  let deleting = $state(false);
  let confirmation = $state("");
  let deleteError = $state<string | null>(null);

  const vault = createQuery(() => ({
    queryKey: ["vault", vaultId, "detail"],
    queryFn: () => getVaultDetail(vaultId),
    enabled: !!vaultId,
  }));
  const members = createQuery(() => ({
    queryKey: ["vault", vaultId, "members"],
    queryFn: () => listMembers(vaultId),
    enabled: !!vaultId,
  }));
  const config = createQuery(() => ({
    queryKey: ["vault", vaultId, "config"],
    queryFn: () => getVaultConfig(vaultId),
    enabled: !!vaultId,
  }));
  const isOwner = $derived(
    members.data?.some(
      (member) => member.user_id === auth.userId && member.role === "owner",
    ) ?? false,
  );
  const loading = $derived(
    vault.isLoading || members.isLoading || config.isLoading,
  );

  async function refreshMembers() {
    await queryClient.invalidateQueries({
      queryKey: ["vault", vaultId, "members"],
    });
    await queryClient.invalidateQueries({
      queryKey: ["vault", vaultId, "detail"],
    });
  }

  async function submitInvite(event: SubmitEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!address || invitePending) return;
    invitePending = true;
    try {
      await inviteMember(vaultId, address, inviteRole);
      email = "";
      await refreshMembers();
    } finally {
      invitePending = false;
    }
  }

  async function saveConfig(data: VaultConfigFormSubmit) {
    savePending = true;
    try {
      await updateVaultConfig(vaultId, {
        thematic_hint: data.thematic_hint,
      });
      await queryClient.invalidateQueries({
        queryKey: ["vault", vaultId, "config"],
      });
    } finally {
      savePending = false;
    }
  }

  async function remove(memberId: string) {
    await removeMember(vaultId, memberId);
    await refreshMembers();
  }

  async function changeRole(memberId: string, role: string) {
    await updateMemberRole(vaultId, memberId, role);
    await refreshMembers();
  }

  async function transfer(memberId: string) {
    await transferOwnership(vaultId, memberId);
    await refreshMembers();
  }

  async function confirmDelete() {
    if (confirmation !== "delete" || deleting) return;
    deleting = true;
    deleteError = null;
    try {
      await deleteVault(vaultId);
      deleteOpen = false;
      confirmation = "";
      await goto("/", { replaceState: true });
    } catch (error) {
      deleteError =
        error instanceof Error ? error.message : "Failed to delete vault.";
    } finally {
      deleting = false;
    }
  }
</script>

<svelte:head>
  <title>Vault settings | Great Minds</title>
</svelte:head>

<div class="flex h-screen flex-col overflow-hidden">
  <PageHeader title="settings" onHome={() => void goto("/")} />

  <div class="min-h-0 flex-1 overflow-y-auto">
    <main class="mx-auto max-w-[740px] px-4 pt-8 pb-20 md:px-10">
      {#if loading || !vault.data}
        <div class="space-y-6">
          <div class="space-y-2">
            <Skeleton class="h-9 w-48 bg-ink-raised" />
            <Skeleton class="h-4 w-36 bg-ink-raised" />
          </div>
          <div class="space-y-3">
            <Skeleton class="h-4 w-24 bg-ink-raised" />
            <Skeleton class="h-10 w-full bg-ink-raised" />
            <Skeleton class="h-10 w-5/6 bg-ink-raised" />
          </div>
        </div>
      {:else}
        <h1 class="mb-1 font-serif text-[length:var(--text-heading)] text-warm">
          {vault.data.name}
        </h1>
        <p
          class="mb-8 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
        >
          {vault.data.article_count} articles · {vault.data.member_count} member{vault
            .data.member_count !== 1
            ? "s"
            : ""}
        </p>

        <h2
          class="mb-4 font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
        >
          members
        </h2>

        <div class="mb-6 space-y-1">
          {#each members.data ?? [] as member (member.user_id)}
            <MemberRow
              {member}
              {isOwner}
              onChangeRole={(role) => changeRole(member.user_id, role)}
              onRemove={() => remove(member.user_id)}
              onTransfer={() => transfer(member.user_id)}
            />
          {/each}
        </div>

        {#if isOwner}
          <form onsubmit={submitInvite} class="flex items-center gap-3">
            <Input
              type="email"
              bind:value={email}
              placeholder="invite by email"
              disabled={invitePending}
              class="h-8 rounded-sm border-ink-border bg-transparent px-3 font-mono text-[length:var(--text-small)] text-warm caret-gold placeholder:text-warm-ghost focus-visible:border-gold-dim focus-visible:ring-0 dark:bg-transparent"
            />
            <Select.Root type="single" bind:value={inviteRole}>
              <Select.Trigger
                size="sm"
                class="h-8 w-24 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
              >
                {inviteRole}
              </Select.Trigger>
              <Select.Content class={SELECT_CONTENT_CLASS}>
                {#each ["editor", "viewer"] as role (role)}
                  <Select.Item
                    value={role}
                    label={role}
                    class={SELECT_ITEM_CLASS}
                  >
                    {role}
                  </Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <span
              class="shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
            >
              ↵
            </span>
          </form>
        {/if}

        {#if config.data}
          <section class="mt-12">
            <h2
              class="mb-4 font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
            >
              configuration
            </h2>
            <VaultConfigForm
              mode="edit"
              initialThematicHint={config.data.thematic_hint}
              submitting={savePending}
              onSubmit={saveConfig}
              submitLabel="save changes"
            />
          </section>
        {/if}

        <ProposalsSection {vaultId} {isOwner} />
        {#if isOwner}
          <section class="mt-16 border-t border-ink-border pt-8">
            <h2
              class="mb-4 font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-red-400/70 uppercase"
            >
              danger zone
            </h2>
            <p
              class="mb-4 text-[length:var(--text-small)] leading-relaxed text-warm-ghost"
            >
              Permanently delete this vault, all its documents, wiki articles,
              and R2 storage. This cannot be undone.
            </p>

            <AlertDialog.Root bind:open={deleteOpen}>
              <AlertDialog.Trigger>
                {#snippet child({ props })}
                  <Button
                    {...props}
                    variant="ghost"
                    class="h-auto rounded-sm px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-red-400/70 hover:bg-red-400/5 hover:text-red-400"
                  >
                    delete vault
                  </Button>
                {/snippet}
              </AlertDialog.Trigger>
              <AlertDialog.Content class={POPOVER_SURFACE_CLASS}>
                <AlertDialog.Header>
                  <AlertDialog.Title
                    class="font-serif text-[length:var(--text-body)] text-warm"
                  >
                    Delete this vault?
                  </AlertDialog.Title>
                  <AlertDialog.Description
                    class="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost"
                  >
                    This permanently deletes the vault, all its documents, wiki
                    articles, and R2 storage. This cannot be undone. Type
                    <span class="text-red-400">delete</span> to confirm.
                  </AlertDialog.Description>
                </AlertDialog.Header>
                <div class="space-y-2">
                  <Input
                    bind:value={confirmation}
                    autofocus
                    disabled={deleting}
                    onkeydown={(event) => {
                      if (
                        event.key === "Enter" &&
                        confirmation === "delete" &&
                        !deleting
                      ) {
                        event.preventDefault();
                        void confirmDelete();
                      }
                    }}
                    class="h-8 rounded-sm border-red-400/30 bg-transparent px-3 font-mono text-[length:var(--text-small)] text-red-400 caret-red-400 placeholder:text-red-400/30 focus-visible:border-red-400/60 focus-visible:ring-0 dark:bg-transparent"
                    placeholder="delete"
                  />
                  {#if deleteError}
                    <Alert
                      variant="destructive"
                      class="rounded-sm border-red-400/25 bg-red-400/5"
                    >
                      <AlertDescription
                        class="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-red-400/90"
                      >
                        {deleteError}
                      </AlertDescription>
                    </Alert>
                  {/if}
                </div>
                <AlertDialog.Footer>
                  <AlertDialog.Cancel
                    disabled={deleting}
                    class="font-mono text-[length:var(--text-chrome)] tracking-[0.08em]"
                  >
                    cancel
                  </AlertDialog.Cancel>
                  <AlertDialog.Action
                    disabled={deleting || confirmation !== "delete"}
                    onclick={(event) => {
                      event.preventDefault();
                      void confirmDelete();
                    }}
                    class="border border-red-400/30 bg-red-400/10 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-red-400 hover:bg-red-400/20 disabled:opacity-40"
                  >
                    {deleting ? "deleting…" : "delete vault"}
                  </AlertDialog.Action>
                </AlertDialog.Footer>
              </AlertDialog.Content>
            </AlertDialog.Root>
          </section>
        {/if}
      {/if}
    </main>
  </div>
</div>
