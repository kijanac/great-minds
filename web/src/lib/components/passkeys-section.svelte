<script lang="ts">
  import { type Passkey, type Uuid } from "@great-minds/domain";
  import X from "@lucide/svelte/icons/x";
  import {
    startRegistration,
    WebAuthnAbortService,
  } from "@simplewebauthn/browser";
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";

  import { api, run } from "$lib/api/app";
  import { errorMessage } from "$lib/api/errors";
  import { registerPasskey } from "$lib/api/passkeys";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { Button } from "$lib/components/ui/button";
  import { POPOVER_SURFACE_CLASS } from "$lib/control-styles";
  import { formatShortDate } from "$lib/utils";

  const queryClient = useQueryClient();
  const passkeysQuery = createQuery(() => ({
    queryKey: ["passkeys"],
    queryFn: () => run(api.auth.listPasskeys()),
  }));
  const remove = createMutation(() => ({
    mutationFn: (id: Uuid) => run(api.auth.deletePasskey({ params: { id } })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
    },
  }));

  let naming = $state(false);
  let name = $state("");
  let adding = $state(false);
  let cancelled = false;
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

  function startNaming(): void {
    naming = true;
    name = defaultPasskeyName();
    addError = null;
  }

  // Safari: no modal or pause between the gesture and credentials.create().
  async function addPasskey(): Promise<void> {
    const trimmed = name.trim();
    if (adding || !trimmed) return;
    adding = true;
    cancelled = false;
    addError = null;
    try {
      const optionsJSON = await run(api.auth.passkeyRegisterOptions());
      const response = await startRegistration({ optionsJSON });
      await registerPasskey(trimmed, response);
      await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
      naming = false;
    } catch (error) {
      if (!cancelled) {
        addError = errorMessage(
          error,
          "We couldn't add this passkey. Please try again.",
        );
      }
    } finally {
      adding = false;
    }
  }

  function cancelAdd(): void {
    if (adding) {
      cancelled = true;
      WebAuthnAbortService.cancelCeremony();
      return;
    }
    naming = false;
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
    {#if !naming}
      <Button
        variant="ghost"
        onclick={startNaming}
        class="h-auto rounded-sm px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint hover:bg-ink-raised hover:text-gold"
      >
        add a passkey
      </Button>
    {/if}
  </div>

  {#if naming}
    <div class="mb-4 flex items-center gap-2">
      <input
        class="flex-1 max-w-[320px] border-0 border-b border-b-gold-dim bg-transparent py-[3px] font-serif text-[length:var(--text-small)] text-warm-dim caret-gold outline-none transition-colors placeholder:text-interactive-dim focus:border-b-gold"
        placeholder="name this passkey"
        bind:value={name}
        disabled={adding}
        onkeydown={(e) => {
          if (e.key === "Enter") void addPasskey();
          if (e.key === "Escape") naming = false;
        }}
      />
      <Button
        variant="outline"
        size="sm"
        onclick={() => void addPasskey()}
        disabled={adding || !name.trim()}
        class="h-auto rounded-sm border-ink-border px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-muted-foreground hover:border-gold-dim hover:text-gold disabled:opacity-25"
      >
        {adding ? "waiting…" : "create"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onclick={cancelAdd}
        class="h-auto px-2 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost hover:bg-transparent hover:text-warm-faint"
      >
        cancel
      </Button>
    </div>
  {/if}

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
