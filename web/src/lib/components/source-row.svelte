<script lang="ts">
  import SourceActionButton from "$lib/components/source-action-button.svelte";
  import type { ReferenceOverview } from "$lib/api/references";
  import type { SourceDocumentSummary } from "$lib/types";
  import { displayTitle, formatShortDate } from "$lib/utils";

  let {
    source,
    role = null,
    busy = false,
    onOpen,
    onDeleteSource,
    onRequestDeletion,
  }: {
    source: SourceDocumentSummary | ReferenceOverview;
    role?: string | null;
    busy?: boolean;
    onOpen: () => void;
    onDeleteSource?: (path: string) => Promise<void>;
    onRequestDeletion?: (path: string) => Promise<void>;
  } = $props();

  const author = $derived("author" in source ? source.author : null);
  const actionable = $derived(
    "source_type" in source &&
      onDeleteSource !== undefined &&
      onRequestDeletion !== undefined,
  );
</script>

<div
  class="group flex min-h-12 items-center gap-2 rounded-sm hover:bg-ink-raised focus-within:bg-ink-raised"
>
  <button
    type="button"
    onclick={onOpen}
    class="flex min-w-0 flex-1 items-center justify-between gap-4 py-2.5 pr-1 pl-3 text-left focus-visible:outline-none"
  >
    <span class="min-w-0 flex-1">
      <span
        class="block truncate font-serif text-[length:var(--text-body)] text-warm-dim transition-colors group-hover:text-warm"
      >
        {displayTitle(source.file_path, source.title)}
      </span>
      {#if author || source.origin}
        <span
          class="mt-0.5 block truncate font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost"
        >
          {[author, source.origin].filter(Boolean).join(" · ")}
        </span>
      {/if}
    </span>
    <span
      class="shrink-0 font-mono text-[length:var(--text-chrome)] text-warm-ghost"
    >
      {formatShortDate(source.updated_at)}
    </span>
  </button>
  {#if actionable && "source_type" in source && onDeleteSource && onRequestDeletion}
    <SourceActionButton
      item={source}
      {role}
      {busy}
      {onDeleteSource}
      {onRequestDeletion}
    />
  {/if}
</div>
