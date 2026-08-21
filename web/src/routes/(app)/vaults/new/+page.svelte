<script lang="ts">
  import { goto } from "$app/navigation";

  import VaultConfigForm, {
    type VaultConfigFormSubmit,
  } from "$lib/components/vault-config-form.svelte";
  import { useCreateVault, useVaults } from "$lib/hooks/use-vault.svelte";

  const vaults = useVaults();
  const createVault = useCreateVault();
  const isFirstRun = $derived((vaults.data?.length ?? 0) === 0);

  async function submit(data: VaultConfigFormSubmit) {
    if (!data.name) return;
    await createVault.mutateAsync({
      name: data.name,
      thematic_hint: data.thematic_hint || undefined,
    });
    await goto("/");
  }
</script>

<svelte:head>
  <title>New vault | Great Minds</title>
</svelte:head>

<div
  class="flex min-h-screen items-start justify-center px-4 pt-16 pb-20 md:px-10"
>
  <div class="w-full max-w-[640px]">
    <h1
      class="mb-2 font-serif text-[length:var(--text-title)] leading-[1.15] text-foreground"
    >
      {isFirstRun ? "Name your first vault" : "New vault"}
    </h1>
    <p
      class="mb-10 font-mono text-[length:var(--text-caption)] tracking-[0.1em] text-warm-ghost"
    >
      {isFirstRun
        ? "a library of sources you can ask across"
        : "set up a new library of sources"}
    </p>

    <VaultConfigForm
      mode="create"
      submitting={createVault.isPending}
      onSubmit={submit}
      onCancel={isFirstRun ? undefined : () => void goto("/")}
      submitLabel="create vault"
    />

    {#if createVault.error}
      <p class="mt-4 font-mono text-[length:var(--text-chrome)] text-red-400">
        {createVault.error.message}
      </p>
    {/if}
  </div>
</div>
