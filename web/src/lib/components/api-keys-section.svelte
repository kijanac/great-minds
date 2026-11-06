<script lang="ts">
  import type { ApiKey, Uuid } from "@great-minds/domain";
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

  import { api, run } from "$lib/api/app";
  import { Button } from "$lib/components/ui/button";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { Input } from "$lib/components/ui/input";
  import * as Select from "$lib/components/ui/select";
  import { SELECT_CONTENT_CLASS, SELECT_ITEM_CLASS } from "$lib/control-styles";
  import { useVaults } from "$lib/hooks/use-vault.svelte";
  import { formatShortDate } from "$lib/utils";

  const EXPIRY = [
    { value: "30", label: "In 30 days", days: 30 },
    { value: "90", label: "In 90 days", days: 90 },
    { value: "365", label: "In a year", days: 365 },
    { value: "never", label: "Never", days: null },
  ] as const;

  const queryClient = useQueryClient();
  const vaults = useVaults();
  const keysQuery = createQuery(() => ({
    queryKey: ["api-keys"],
    queryFn: () => run(api.auth.listApiKeys({})),
  }));
  const create = createMutation(() => ({
    mutationFn: () => {
      const days =
        EXPIRY.find((option) => option.value === expiry)?.days ?? null;
      return run(
        api.auth.createApiKey({
          payload: {
            label: label.trim(),
            vault_ids: allVaults ? null : [...chosen],
            can_ask: canAsk,
            can_change: canChange,
            expires_at:
              days === null ? null : new Date(Date.now() + days * 86_400_000),
          },
        }),
      );
    },
    onSuccess: async () => {
      creating = false;
      await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  }));
  const revoke = createMutation(() => ({
    mutationFn: (keyId: Uuid) =>
      run(api.auth.deleteApiKey({ params: { key_id: keyId } })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  }));

  let creating = $state(false);
  let label = $state("");
  let allVaults = $state(true);
  let chosen = $state<Uuid[]>([]);
  let canAsk = $state(true);
  let canChange = $state(false);
  let expiry = $state<string>("30");
  let copied = $state(false);
  let revokedOpen = $state(false);

  const keys = $derived(keysQuery.data ?? []);
  const active = $derived(keys.filter((key) => !key.revoked));
  const revoked = $derived(keys.filter((key) => key.revoked));
  const vaultName = $derived(
    new Map((vaults.data ?? []).map((vault) => [vault.id, vault.name])),
  );
  const canCreate = $derived(
    label.trim().length > 0 && (allVaults || chosen.length > 0),
  );

  function startCreating() {
    label = "";
    allVaults = true;
    chosen = [];
    canAsk = true;
    canChange = false;
    expiry = "30";
    create.reset();
    creating = true;
  }

  function toggleVault(id: Uuid) {
    allVaults = false;
    chosen = chosen.includes(id)
      ? chosen.filter((existing) => existing !== id)
      : [...chosen, id];
  }

  function scopeText(key: ApiKey): string {
    const reach =
      key.vault_ids === null
        ? "all vaults"
        : key.vault_ids.map((id) => vaultName.get(id) ?? "a vault").join(", ");
    const can = key.can_change
      ? "adds documents"
      : key.can_ask
        ? "reads and asks"
        : "read-only";
    return `${reach} · ${can}`;
  }

  function useText(key: ApiKey): string {
    const parts = [`created ${formatShortDate(key.created_at)}`];
    parts.push(
      key.expires_at === null
        ? "never expires"
        : key.expires_at.getTime() < Date.now()
          ? "expired"
          : `expires ${formatShortDate(key.expires_at)}`,
    );
    parts.push(
      key.last_used_at === null
        ? "never used"
        : `used ${formatShortDate(key.last_used_at)}`,
    );
    return parts.join(" · ");
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    copied = true;
    window.setTimeout(() => (copied = false), 1500);
  }

  const optionClass =
    "flex cursor-pointer items-start gap-2.5 py-1 text-[length:var(--text-small)] text-warm-dim";
  const boxClass = "mt-0.5 h-4 w-4 shrink-0 accent-gold disabled:opacity-70";
  const hintClass =
    "block font-mono text-[length:var(--text-chrome)] text-warm-ghost";
  const fieldLabelClass =
    "mt-4 mb-1.5 block font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost";
</script>

<section class="mt-12">
  <div class="mb-4 flex items-center justify-between gap-4">
    <h2
      class="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
    >
      api keys
    </h2>
    {#if !creating && !create.data}
      <Button
        variant="ghost"
        onclick={startCreating}
        class="h-auto rounded-sm px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint hover:bg-ink-raised hover:text-gold"
      >
        New key
      </Button>
    {/if}
  </div>

  {#if create.data}
    <div class="mb-6 rounded-sm border border-gold-dim bg-gold/10 p-4">
      <div class="mb-3 flex items-start justify-between gap-3">
        <div
          class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-gold"
        >
          Copy it now. It won't be shown again.
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
          class="flex-1 rounded-sm bg-ink-raised px-3 py-2 font-mono text-[length:var(--text-small)] break-all text-warm"
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
  {:else if creating}
    <form
      class="mb-6 rounded-sm border border-ink-subtle bg-ink-raised p-5"
      onsubmit={(event) => {
        event.preventDefault();
        if (canCreate && !create.isPending) create.mutate();
      }}
    >
      <label for="key-name" class={fieldLabelClass} style="margin-top:0"
        >Name</label
      >
      <Input
        id="key-name"
        bind:value={label}
        placeholder="Reading script"
        class="h-8 rounded-sm border-ink-border bg-transparent px-3 text-[length:var(--text-small)] text-warm caret-gold placeholder:text-warm-ghost focus-visible:border-gold-dim focus-visible:ring-0 dark:bg-transparent"
      />

      <span class={fieldLabelClass}>Vaults</span>
      <label class={optionClass}>
        <input
          type="checkbox"
          class={boxClass}
          checked={allVaults}
          onchange={() => {
            allVaults = !allVaults;
            if (allVaults) chosen = [];
          }}
        />
        All my vaults, including new ones
      </label>
      {#each vaults.data ?? [] as vault (vault.id)}
        <label class={optionClass}>
          <input
            type="checkbox"
            class={boxClass}
            checked={!allVaults && chosen.includes(vault.id)}
            onchange={() => toggleVault(vault.id)}
          />
          {vault.name}
        </label>
      {/each}

      <span class={fieldLabelClass}>Can</span>
      <label class={optionClass}>
        <input type="checkbox" class={boxClass} checked disabled />
        <span
          >Read articles and sources<span class={hintClass}
            >Every key can read the vaults it reaches.</span
          ></span
        >
      </label>
      <label class={optionClass}>
        <input type="checkbox" class={boxClass} bind:checked={canAsk} />
        <span
          >Ask questions<span class={hintClass}>Answers call paid models.</span
          ></span
        >
      </label>
      <label class={optionClass}>
        <input type="checkbox" class={boxClass} bind:checked={canChange} />
        <span
          >Add documents and start Updates<span class={hintClass}
            >Updates call paid models.</span
          ></span
        >
      </label>

      <span class={fieldLabelClass}>Expires</span>
      <Select.Root type="single" bind:value={expiry}>
        <Select.Trigger
          size="sm"
          aria-label="Expires"
          class="h-8 w-40 text-[length:var(--text-small)] text-warm-dim"
        >
          {EXPIRY.find((option) => option.value === expiry)?.label}
        </Select.Trigger>
        <Select.Content class={SELECT_CONTENT_CLASS}>
          {#each EXPIRY as option (option.value)}
            <Select.Item
              value={option.value}
              label={option.label}
              class={SELECT_ITEM_CLASS}>{option.label}</Select.Item
            >
          {/each}
        </Select.Content>
      </Select.Root>

      <div class="mt-5 flex items-center gap-4">
        <Button
          type="submit"
          disabled={!canCreate || create.isPending}
          class="h-auto rounded-sm bg-gold px-4 py-2 font-mono text-[length:var(--text-chrome)] font-medium tracking-[0.1em] text-primary-foreground hover:bg-gold-hover disabled:bg-interactive-ghost disabled:text-muted-foreground disabled:opacity-100"
        >
          Create key
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onclick={() => (creating = false)}
          class="h-auto rounded-sm px-3 py-0.5 font-mono text-[length:var(--text-chrome)] tracking-[0.1em] text-warm-ghost hover:bg-transparent hover:text-warm-faint"
        >
          Cancel
        </Button>
      </div>
    </form>
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
          class="group flex items-center justify-between gap-3 rounded-sm px-3 py-2 hover:bg-ink-raised"
        >
          <div class="min-w-0">
            <div class="truncate text-[length:var(--text-small)] text-warm-dim">
              {key.label}
            </div>
            <div
              class="truncate font-mono text-[length:var(--text-chrome)] text-warm-ghost"
            >
              {scopeText(key)} · {useText(key)}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            onclick={() => revoke.mutate(key.id)}
            disabled={revoke.isPending}
            class="shrink-0 text-warm-ghost opacity-0 transition-opacity group-hover:opacity-100 hover:bg-transparent hover:text-red-400 focus-visible:opacity-100"
            aria-label={`revoke ${key.label}`}
          >
            <X size={12} />
          </Button>
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
                    class="truncate text-[length:var(--text-small)] text-warm-ghost line-through"
                  >
                    {key.label}
                  </span>
                  <span
                    class="shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
                  >
                    {key.last_used_at === null
                      ? "never used"
                      : `last used ${formatShortDate(key.last_used_at)}`}
                  </span>
                </div>
              {/each}
            </div>
          </Collapsible.Content>
        </Collapsible.Root>
      {/if}
    </div>
  {/if}
</section>
