<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import Copy from "@lucide/svelte/icons/copy";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import type { Snippet } from "svelte";

  import { createShare, deleteShare } from "$lib/api/shares";
  import { Button } from "$lib/components/ui/button";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { POPOVER_SURFACE_CLASS } from "$lib/control-styles";

  let {
    subjectKind,
    subjectId,
    trigger,
  }: {
    subjectKind: "session" | "reference";
    subjectId: string;
    trigger?: Snippet<[{ props: Record<string, unknown> }]>;
  } = $props();

  let open = $state(false);
  let pending = $state(false);
  let revoking = $state(false);
  let error = $state<string | null>(null);
  let shareId = $state<string | null>(null);
  let token = $state<string | null>(null);
  let copied = $state(false);
  let includeAnnotations = $state(true);

  const link = $derived(token ? `${location.origin}/s/${token}` : null);

  async function create(include: boolean = includeAnnotations) {
    pending = true;
    error = null;
    try {
      const result = await createShare({
        subject_kind: subjectKind,
        subject_id: subjectId,
        include_annotations: include,
      });
      shareId = result.share.id;
      token = result.share.token;
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "Failed to create share link";
    } finally {
      pending = false;
    }
  }

  async function toggleAnnotations() {
    const next = !includeAnnotations;
    includeAnnotations = next;
    // The backend keeps one share per subject and updates the flag in place.
    await create(next);
  }

  async function recreate() {
    if (!shareId) return;
    revoking = true;
    error = null;
    try {
      await deleteShare(shareId);
      const result = await createShare({
        subject_kind: subjectKind,
        subject_id: subjectId,
        include_annotations: includeAnnotations,
      });
      shareId = result.share.id;
      token = result.share.token;
      copied = false;
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "Failed to create a new share link";
    } finally {
      revoking = false;
    }
  }

  function reset() {
    open = false;
    pending = false;
    revoking = false;
    error = null;
    shareId = null;
    token = null;
    copied = false;
    includeAnnotations = true;
  }

  async function copy() {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    copied = true;
    window.setTimeout(() => (copied = false), 1500);
  }
</script>

<AlertDialog.Root
  bind:open
  onOpenChange={(next) => {
    if (next) {
      void create();
    } else {
      reset();
    }
  }}
>
  <AlertDialog.Trigger>
    {#snippet child({ props })}
      {#if trigger}
        {@render trigger({ props })}
      {:else}
        <Button
          {...props}
          variant="outline"
          size="sm"
          class="h-8 rounded-sm border-gold-dim bg-transparent px-3 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-gold-muted hover:bg-ink-raised hover:text-gold"
        >
          share
        </Button>
      {/if}
    {/snippet}
  </AlertDialog.Trigger>
  <AlertDialog.Content class={POPOVER_SURFACE_CLASS}>
    <AlertDialog.Header>
      <AlertDialog.Title
        class="font-serif text-[length:var(--text-body)] text-warm"
      >
        {subjectKind === "reference" ? "Share reference" : "Share session"}
      </AlertDialog.Title>
      <AlertDialog.Description
        class="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost"
      >
        {token
          ? "anyone with this link can read it — reopening shows the same link"
          : "creating a read-only link for anyone"}
      </AlertDialog.Description>
    </AlertDialog.Header>

    {#if token && link}
      <div class="flex items-center gap-2">
        <code
          class="flex-1 break-all rounded-sm bg-ink-raised px-3 py-2 font-mono text-[length:var(--text-small)] text-warm"
        >
          {link}
        </code>
        <Button
          variant="ghost"
          size="icon-sm"
          onclick={() => void copy()}
          aria-label="copy share link"
          class="shrink-0 text-warm-ghost hover:text-gold"
        >
          {#if copied}
            <Check size={14} />
          {:else}
            <Copy size={14} />
          {/if}
        </Button>
      </div>
      {#if subjectKind === "reference"}
        <button
          type="button"
          role="checkbox"
          aria-checked={includeAnnotations}
          onclick={() => void toggleAnnotations()}
          disabled={pending}
          class="flex items-center gap-2.5 self-start rounded-sm border border-ink-border px-3 py-1.5 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost transition-colors hover:border-gold-dim hover:text-warm-faint disabled:opacity-60"
        >
          <span
            class={`flex h-3.5 w-3.5 items-center justify-center border text-[10px] leading-none ${includeAnnotations ? "border-gold-dim bg-gold/15 text-gold" : "border-ink-border text-transparent"}`}
          >
            ✓
          </span>
          include annotations
        </button>
      {/if}
    {:else if pending}
      <p
        class="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-dim"
      >
        creating…
      </p>
    {/if}
    {#if error}
      <p
        class="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-destructive"
      >
        {error}
      </p>
    {/if}

    <AlertDialog.Footer>
      {#if token}
        <Button
          variant="ghost"
          size="sm"
          onclick={() => void recreate()}
          disabled={revoking}
          class="mr-auto h-8 rounded-sm px-3 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost hover:text-gold"
        >
          <RefreshCw size={14} />
          {revoking ? "creating new link…" : "revoke and create new link"}
        </Button>
        <AlertDialog.Cancel
          class="h-8 rounded-sm font-mono text-[length:var(--text-chrome)] tracking-[0.08em]"
        >
          done
        </AlertDialog.Cancel>
      {:else}
        <AlertDialog.Cancel
          class="h-8 rounded-sm font-mono text-[length:var(--text-chrome)] tracking-[0.08em]"
        >
          cancel
        </AlertDialog.Cancel>
        <Button
          size="sm"
          onclick={() => void create()}
          disabled={pending}
          class="h-8 rounded-sm px-3 font-mono text-[length:var(--text-chrome)] tracking-[0.08em]"
        >
          {pending ? "creating…" : "create link"}
        </Button>
      {/if}
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
