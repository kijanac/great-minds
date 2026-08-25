<script lang="ts">
  import FileX from "@lucide/svelte/icons/file-x";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  import type { SourceDocumentSummary } from "$lib/api/sources";
  import { Button } from "$lib/components/ui/button";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { POPOVER_SURFACE_CLASS } from "$lib/control-styles";

  let {
    item,
    role,
    busy = false,
    onDeleteSource,
    onRequestDeletion,
  }: {
    item: SourceDocumentSummary;
    role: string | null;
    busy?: boolean;
    onDeleteSource: (sourceId: string) => Promise<void>;
    onRequestDeletion: (sourceId: string) => Promise<void>;
  } = $props();

  let open = $state(false);

  const action = $derived(
    role === "owner"
      ? {
          label: "delete source",
          kind: "delete" as const,
          title: "Delete this source?",
          description:
            "This removes the source and search entries now. Existing compiled wiki pages will stay as-is until a future compile.",
          confirm: "delete source",
        }
      : role === "editor"
        ? {
            label: "request deletion",
            kind: "request" as const,
            title: "Request source deletion?",
            description: "An owner can review this request from proposals.",
            confirm: "request deletion",
          }
        : null,
  );

  async function confirm() {
    if (!action || busy) return;
    try {
      if (action.kind === "delete") await onDeleteSource(item.id);
      else await onRequestDeletion(item.id);
      open = false;
    } catch {
      // The library owns the visible error message.
    }
  }
</script>

{#if action}
  <AlertDialog.Root bind:open>
    <AlertDialog.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="icon-xs"
          aria-label={action.label}
          disabled={busy}
          class="mr-2 shrink-0 text-warm-ghost opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-transparent hover:text-gold focus-visible:opacity-100"
        >
          {#if action.kind === "delete"}
            <Trash2 class="size-3.5" />
          {:else}
            <FileX class="size-3.5" />
          {/if}
        </Button>
      {/snippet}
    </AlertDialog.Trigger>
    <AlertDialog.Content class={POPOVER_SURFACE_CLASS}>
      <AlertDialog.Header>
        <AlertDialog.Title
          class="font-serif text-[length:var(--text-body)] text-warm"
        >
          {action.title}
        </AlertDialog.Title>
        <AlertDialog.Description
          class="font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost"
        >
          {action.description}
        </AlertDialog.Description>
      </AlertDialog.Header>
      <div class="rounded-sm border border-gold-dim/70 bg-gold/5 px-3 py-2">
        <p
          class="truncate font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-gold-muted"
        >
          {item.title ?? item.file_path}
        </p>
        {#if item.title}
          <p
            class="mt-1 truncate font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost"
          >
            {item.file_path}
          </p>
        {/if}
      </div>
      <AlertDialog.Footer>
        <AlertDialog.Cancel
          disabled={busy}
          class="font-mono text-[length:var(--text-chrome)] tracking-[0.08em]"
        >
          cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          disabled={busy}
          onclick={(event) => {
            event.preventDefault();
            void confirm();
          }}
          class="border border-gold-dim bg-gold/10 font-mono text-[length:var(--text-chrome)] tracking-[0.08em] text-gold hover:bg-gold/20 disabled:opacity-40"
        >
          {busy ? "working..." : action.confirm}
        </AlertDialog.Action>
      </AlertDialog.Footer>
    </AlertDialog.Content>
  </AlertDialog.Root>
{/if}
