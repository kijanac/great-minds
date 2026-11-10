<script lang="ts">
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import { tick, untrack } from "svelte";
  import ExportMessageRow from "#lib/components/export-message.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { LoadingState } from "#lib/components/ui/feedback/index.ts";
  import type { SessionExport } from "#lib/hooks/use-session-export.svelte.ts";

  let { publication, onClose }: { publication: SessionExport; onClose: () => void } = $props();
  const selectedCount = $derived(publication.messages.filter((entry) => entry.selected).length);
  const formatLabel = $derived(publication.format === "pdf" ? "PDF" : "Markdown");
  let backButton: HTMLButtonElement | HTMLAnchorElement | null = $state(null);
  let previewButton: HTMLButtonElement | HTMLAnchorElement | null = $state(null);
  let downloadButton: HTMLButtonElement | HTMLAnchorElement | null = $state(null);

  $effect(() => {
    if (publication.previewing) backButton?.focus();
  });
  $effect(() => {
    if (publication.prepared?.autoDownload) untrack(() => downloadButton?.click());
  });

  async function back() {
    if (!publication.previewing) return onClose();
    publication.chooseMessages();
    await tick();
    previewButton?.focus();
  }
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Conversation export">
  <header class="shrink-0 px-5 pt-3 pb-5 sm:px-10 sm:pt-5">
    <div class="mx-auto max-w-3xl">
      <Button
        variant="ghost"
        onclick={back}
        bind:ref={backButton}
        aria-label={publication.previewing ? "Back to messages" : "Back to conversation"}
        class="min-h-11 rounded-sm px-0 font-mono text-xs text-warm-faint hover:text-warm"
        ><ArrowLeft size={14} /> Back</Button
      >
      <h2 class="mt-1 text-[length:var(--text-heading)]">Export conversation</h2>
    </div>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto px-5 sm:px-10" hidden={publication.previewing}>
    <div class="mx-auto max-w-3xl pb-8">
      {#if publication.messages.length === 0}
        {#if publication.pending}
          <div class="py-12" role="status"><LoadingState label="Loading messages…" /></div>
        {:else if publication.error}
          <p class="pt-4 text-warm-faint" role="alert">{publication.error}</p>
          <Button
            variant="outline"
            onclick={publication.begin}
            class="mt-4 min-h-11 rounded-sm font-mono text-xs">Try again</Button
          >
        {:else}
          <p class="py-8 text-warm-faint">No saved messages to export yet.</p>
        {/if}
      {:else}
        <div
          class="flex items-center justify-between gap-4 border-b border-ink-subtle pb-2 font-mono text-xs"
        >
          <label class="flex min-h-11 cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={selectedCount === publication.messages.length}
              indeterminate={selectedCount > 0 && selectedCount < publication.messages.length}
              disabled={publication.pending}
              onchange={(event) => publication.select("all", event.currentTarget.checked)}
              class="size-4 cursor-pointer accent-gold disabled:cursor-wait"
            />
            All messages
          </label>
          <span class="text-warm-faint" aria-live="polite">{selectedCount} selected</span>
        </div>
        <ol class="divide-y divide-ink-subtle">
          {#each publication.messages as entry, index}
            <li>
              {#if entry.note && publication.messages[index - 1]?.message.session_id !== entry.message.session_id}
                <h3 class="pt-7 font-mono text-xs text-warm-faint">Attached note</h3>
              {/if}
              <ExportMessageRow
                {entry}
                {index}
                disabled={publication.pending}
                onSelect={(selected) => publication.select(index, selected)}
              />
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </div>

  {#if publication.previewing && publication.prepared}
    <iframe
      src={`${publication.prepared.url}#view=FitH&navpanes=0`}
      title="Conversation PDF preview"
      class="min-h-0 w-full flex-1 border-0 bg-ink-raised"
    ></iframe>
  {/if}

  <footer
    class="shrink-0 border-t border-ink-subtle px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-10"
  >
    <div class="mx-auto max-w-3xl">
      {#if publication.error && publication.messages.length > 0}<p
          class="pb-3 text-[length:var(--text-caption)] text-warm-faint"
          role="alert"
        >
          {publication.error}
        </p>{/if}
      <div class="flex flex-wrap items-center justify-between gap-x-1 gap-y-2 sm:gap-x-3">
        {#if publication.previewing}
          <p class="font-mono text-xs text-warm-faint">
            {selectedCount} messages · {publication.paper === "a4" ? "A4" : "Letter"}
          </p>
        {:else}
          <div class="flex items-center gap-2">
            <label class="relative flex min-h-11 items-center">
              <span class="sr-only">Export format</span>
              <select
                value={publication.format}
                disabled={publication.pending}
                onchange={(event) =>
                  publication.changeFormat(
                    event.currentTarget.value === "pdf" ? "pdf" : "markdown",
                  )}
                class="min-h-11 cursor-pointer rounded-sm bg-transparent py-2 font-mono text-xs text-warm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold"
                class:w-14={publication.format === "pdf"}
                class:w-24={publication.format === "markdown"}
              >
                <option value="pdf">PDF</option><option value="markdown">Markdown</option>
              </select>
            </label>
            {#if publication.format === "pdf"}
              <label class="relative flex min-h-11 items-center">
                <span class="sr-only">Paper size</span>
                <select
                  value={publication.paper}
                  disabled={publication.pending}
                  onchange={(event) =>
                    publication.changePaper(
                      event.currentTarget.value === "a4" ? "a4" : "us-letter",
                    )}
                  class="min-h-11 w-16 cursor-pointer rounded-sm bg-transparent py-2 font-mono text-xs text-warm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold"
                >
                  <option value="a4">A4</option><option value="us-letter">Letter</option>
                </select>
              </label>
            {/if}
          </div>
        {/if}
        <div class="ml-auto flex items-center gap-3">
          {#if publication.previewing && publication.prepared}
            <Button
              variant="ghost"
              href={publication.prepared.url}
              target="_blank"
              rel="noopener noreferrer"
              class="min-h-11 rounded-sm px-1 font-mono text-xs text-warm-faint"
              >Open in new tab</Button
            >
          {:else if publication.format === "pdf"}
            <Button
              variant="ghost"
              onclick={() => publication.prepare("preview")}
              bind:ref={previewButton}
              disabled={publication.pending || selectedCount === 0}
              class="min-h-11 rounded-sm px-1 font-mono text-xs text-warm-faint">Preview</Button
            >
          {/if}
          <Button
            bind:ref={downloadButton}
            href={publication.prepared?.url}
            download={publication.prepared?.filename}
            onclick={publication.prepared ? undefined : () => publication.prepare("download")}
            disabled={publication.pending || selectedCount === 0}
            class={`min-h-11 rounded-sm px-4 font-mono text-xs ${publication.format === "pdf" ? "min-w-32" : "min-w-44"}`}
          >
            {publication.pending && publication.messages.length > 0
              ? `Preparing ${formatLabel}…`
              : `Download ${formatLabel}`}
          </Button>
        </div>
      </div>
      <span class="sr-only" role="status"
        >{publication.prepared ? `${formatLabel} is ready to download.` : ""}</span
      >
    </div>
  </footer>
</section>
