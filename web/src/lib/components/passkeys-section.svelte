<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import { startRegistration } from "@simplewebauthn/browser";
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";

  import {
    deletePasskey,
    getPasskeyRegistrationOptions,
    listPasskeys,
    registerPasskey,
    type Passkey,
  } from "$lib/api/passkeys";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { Button } from "$lib/components/ui/button";
  import { POPOVER_SURFACE_CLASS } from "$lib/control-styles";
  import { formatShortDate } from "$lib/utils";

  const queryClient = useQueryClient();
  const passkeysQuery = createQuery(() => ({
    queryKey: ["passkeys"],
    queryFn: listPasskeys,
  }));
  const remove = createMutation(() => ({
    mutationFn: deletePasskey,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
    },
  }));

  let adding = $state(false);
  let addError = $state<string | null>(null);
  let deleteOpen = $state(false);
  let selected = $state<Passkey | null>(null);

  function defaultPasskeyName(): string {
    const agent = navigator.userAgent;
    const browser = agent.includes("Edg/")
      ? "Edge"
      : agent.includes("Firefox/")
        ? "Firefox"
        : agent.includes("Chrome/") || agent.includes("CriOS/")
          ? "Chrome"
          : agent.includes("Safari/")
            ? "Safari"
            : "Browser";
    const os = /iPhone|iPad/.test(agent)
      ? "iOS"
      : agent.includes("Mac OS")
        ? "macOS"
        : agent.includes("Windows")
          ? "Windows"
          : agent.includes("Android")
            ? "Android"
            : agent.includes("Linux")
              ? "Linux"
              : "this device";
    return `${browser} on ${os}`;
  }

  async function addPasskey(): Promise<void> {
    if (adding) return;
    const name = window
      .prompt("Name this passkey", defaultPasskeyName())
      ?.trim();
    if (!name) return;

    adding = true;
    addError = null;
    try {
      const optionsJSON = await getPasskeyRegistrationOptions();
      const response = await startRegistration({ optionsJSON });
      await registerPasskey(name, response);
      await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
    } catch (error) {
      addError =
        error instanceof Error
          ? error.message
          : "We couldn't add this passkey. Please try again.";
    } finally {
      adding = false;
    }
  }

  function askToDelete(passkey: Passkey): void {
    selected = passkey;
    deleteOpen = true;
  }

  async function confirmDelete(): Promise<void> {
    if (selected === null || remove.isPending) return;
    await remove.mutateAsync(selected.id);
    deleteOpen = false;
    selected = null;
  }
</script>

<section class="mt-12">
  <div class="mb-4 flex items-center justify-between gap-4">
    <h2
      class="font-mono text-[length:var(--text-chrome)] tracking-[0.14em] text-gold-muted uppercase"
    >
      passkeys
    </h2>
    <Button
      variant="ghost"
      onclick={() => void addPasskey()}
      disabled={adding}
      class="h-auto rounded-sm px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint hover:bg-ink-raised hover:text-gold"
    >
      {adding ? "waiting…" : "add a passkey"}
    </Button>
  </div>

  {#if addError}
    <Alert
      variant="destructive"
      class="mb-4 rounded-sm border-red-400/25 bg-red-400/5"
    >
      <AlertDescription
        class="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-red-400/90"
      >
        {addError}
      </AlertDescription>
    </Alert>
  {/if}

  {#if passkeysQuery.isLoading}
    <p
      class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
    >
      loading…
    </p>
  {:else if (passkeysQuery.data ?? []).length === 0}
    <p
      class="max-w-[58ch] text-[length:var(--text-small)] leading-relaxed text-warm-ghost"
    >
      No passkeys yet. Add one to sign in with your device, security key, or
      password manager.
    </p>
  {:else}
    <div class="space-y-1">
      {#each passkeysQuery.data ?? [] as passkey (passkey.id)}
        <div
          class="group flex min-h-12 items-center justify-between gap-4 rounded-sm px-3 py-2 hover:bg-ink-raised"
        >
          <div class="min-w-0">
            <div
              class="truncate font-mono text-[length:var(--text-small)] text-warm-dim"
            >
              {passkey.name}
            </div>
            <div
              class="mt-0.5 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
            >
              added {formatShortDate(passkey.created_at)} · {passkey.last_used_at
                ? `last used ${formatShortDate(passkey.last_used_at)}`
                : "never used"}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            onclick={() => askToDelete(passkey)}
            class="shrink-0 text-warm-ghost opacity-0 transition-opacity group-hover:opacity-100 hover:bg-transparent hover:text-red-400 focus-visible:opacity-100"
            aria-label={`delete ${passkey.name}`}
          >
            <X size={12} />
          </Button>
        </div>
      {/each}
    </div>
  {/if}
</section>

<AlertDialog.Root bind:open={deleteOpen}>
  <AlertDialog.Content class={POPOVER_SURFACE_CLASS}>
    <AlertDialog.Header>
      <AlertDialog.Title
        class="font-serif text-[length:var(--text-body)] text-warm"
      >
        Delete this passkey?
      </AlertDialog.Title>
      <AlertDialog.Description
        class="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost"
      >
        {selected?.name ?? "This passkey"} will no longer work for signing in. Other
        passkeys and email sign-in will still be available.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel
        disabled={remove.isPending}
        class="font-mono text-[length:var(--text-chrome)] tracking-[0.08em]"
      >
        keep passkey
      </AlertDialog.Cancel>
      <AlertDialog.Action
        disabled={remove.isPending}
        onclick={(event) => {
          event.preventDefault();
          void confirmDelete();
        }}
        class="border border-red-400/30 bg-red-400/10 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-red-400 hover:bg-red-400/20 disabled:opacity-40"
      >
        {remove.isPending ? "deleting…" : "delete passkey"}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
