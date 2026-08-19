<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import Copy from "@lucide/svelte/icons/copy";
  import type { Snippet } from "svelte";

  import {
    createShare,
    deleteShare,
    listShares,
    type ShareOverview,
  } from "$lib/api/shares";
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
  let loading = $state(false);
  let creating = $state(false);
  let revoking = $state(false);
  let error = $state<string | null>(null);
  let share = $state<ShareOverview | null>(null);
  let copied = $state(false);
  let created = $state(false);
  let includeAnnotations = $state(true);

  const link = $derived(share ? `${location.origin}/s/${share.token}` : null);
  const displayLink = $derived(link ? ellipsizeMiddle(link) : null);

  function ellipsizeMiddle(url: string, max = 36): string {
    const bare = url.replace(/^https?:\/\//, "");
    if (bare.length <= max) return bare;
    const head = Math.ceil(max * 0.55);
    const tail = max - head - 1;
    return `${bare.slice(0, head)}…${bare.slice(-tail)}`;
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const shares = await listShares();
      share =
        shares.find(
          (s) =>
            s.subject_kind === subjectKind &&
            s.subject_id === subjectId &&
            s.revoked_at === null,
        ) ?? null;
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "Failed to load share status";
    } finally {
      loading = false;
    }
  }

  async function create() {
    creating = true;
    error = null;
    try {
      const result = await createShare({
        subject_kind: subjectKind,
        subject_id: subjectId,
        include_annotations: includeAnnotations,
      });
      share = result.share;
      created = true;
      window.setTimeout(() => (created = false), 1500);
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "Failed to create share link";
    } finally {
      creating = false;
    }
  }

  async function revoke() {
    if (!share) return;
    revoking = true;
    error = null;
    try {
      await deleteShare(share.id);
      share = null;
      copied = false;
      created = false;
      includeAnnotations = true;
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "Failed to revoke share link";
    } finally {
      revoking = false;
    }
  }

  function reset() {
    open = false;
    loading = false;
    creating = false;
    revoking = false;
    error = null;
    share = null;
    copied = false;
    created = false;
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
      void load();
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
        anyone with this link can read it
      </AlertDialog.Description>
    </AlertDialog.Header>

    {#if loading}
      <p
        class="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-dim"
      >
        loading…
      </p>
    {:else if share && link}
      <div
        class="flex items-center gap-1 rounded-sm bg-ink-raised py-1 pr-1 pl-3"
      >
        <code
          class="min-w-0 flex-1 overflow-hidden font-mono text-[length:var(--text-small)] whitespace-nowrap text-warm"
          title={link}
        >
          {displayLink}
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
        <p
          class="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost"
        >
          {share.include_annotations ? "includes your notes" : "article only"}
        </p>
      {/if}
      {#if copied}
        <p
          class="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-dim"
        >
          copied
        </p>
      {/if}
    {:else}
      {#if subjectKind === "reference"}
        <label
          class="flex items-center gap-2 self-start font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
        >
          <input
            type="checkbox"
            bind:checked={includeAnnotations}
            disabled={creating}
            class="h-4 w-4 shrink-0 accent-gold"
          />
          include your notes
        </label>
      {/if}
    {/if}

    {#if created}
      <p
        class="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-dim"
      >
        link created
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
      {#if share}
        <Button
          variant="ghost"
          size="sm"
          onclick={() => void revoke()}
          disabled={revoking}
          class="mr-auto h-8 rounded-sm px-3 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-warm-ghost hover:text-gold"
        >
          {revoking ? "revoking…" : "revoke link"}
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
          disabled={creating || loading}
          class="h-8 rounded-sm px-3 font-mono text-[length:var(--text-chrome)] tracking-[0.08em]"
        >
          {creating ? "creating…" : "create share link"}
        </Button>
      {/if}
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
