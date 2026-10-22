<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import Pencil from "@lucide/svelte/icons/pencil";
  import X from "@lucide/svelte/icons/x";
  import { tick } from "svelte";

  import { errorMessage } from "$lib/api/errors";
  import { Button } from "$lib/components/ui/button";

  let {
    name,
    editable,
    onRename,
  }: {
    name: string;
    editable: boolean;
    onRename: (name: string) => Promise<void>;
  } = $props();

  let editing = $state(false);
  let draft = $state("");
  let saving = $state(false);
  let error = $state<string | null>(null);
  let pencil = $state<HTMLButtonElement | null>(null);

  function selectName(input: HTMLInputElement) {
    void tick().then(() => {
      input.focus();
      input.select();
    });
  }

  async function finishEditing() {
    editing = false;
    await tick();
    pencil?.focus();
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (saving || !next) return;
    if (next === name) return finishEditing();
    saving = true;
    error = null;
    try {
      await onRename(next);
      await finishEditing();
    } catch (cause) {
      error = errorMessage(cause, "Couldn’t rename this vault. Try again.");
    } finally {
      saving = false;
    }
  }
</script>

{#if editable && editing}
  <form onsubmit={save} aria-busy={saving} class="mb-1">
    <div class="flex items-center gap-2">
      <input
        use:selectName
        bind:value={draft}
        aria-label="Vault name"
        aria-invalid={error !== null}
        aria-describedby={error ? "vault-name-error" : undefined}
        required
        disabled={saving}
        onkeydown={(event) => {
          if (event.key === "Escape" && !saving) {
            event.preventDefault();
            void finishEditing();
          }
        }}
        class="min-w-0 flex-1 border-b border-gold bg-transparent py-1 font-serif text-[length:var(--text-heading)] text-warm caret-gold outline-none"
      />
      <Button
        type="submit"
        variant="ghost"
        size="icon"
        disabled={saving || !draft.trim()}
        aria-label="Save vault name"
        class="text-gold"
      >
        <Check size={16} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        disabled={saving}
        onclick={() => void finishEditing()}
        aria-label="Cancel rename"
        class="text-warm-ghost"
      >
        <X size={16} />
      </Button>
    </div>
    {#if error}
      <p
        id="vault-name-error"
        role="alert"
        class="mt-2 font-mono text-[length:var(--text-chrome)] text-destructive"
      >
        {error}
      </p>
    {/if}
  </form>
{:else}
  <div class="mb-1 flex items-start gap-2">
    <h1
      class="min-w-0 font-serif text-[length:var(--text-heading)] break-words text-warm"
    >
      {name}
    </h1>
    {#if editable}
      <Button
        bind:ref={pencil}
        variant="ghost"
        size="icon"
        aria-label="Rename vault"
        onclick={() => {
          draft = name;
          error = null;
          editing = true;
        }}
        class="text-warm-ghost hover:text-gold"
      >
        <Pencil size={14} />
      </Button>
    {/if}
  </div>
{/if}
