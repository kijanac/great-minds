<script lang="ts">
  import type { PublicationPaper } from "@great-minds/domain";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { LoadingState } from "#lib/components/ui/feedback/index.ts";
  import type { ExportMessage, PreparedExport } from "#lib/hooks/use-session-export.svelte.ts";

  let {
    pending,
    selecting,
    messages,
    onSelect,
    onSelectAll,
    onChooseMessages,
    onReload,
    error,
    prepared,
    paper,
    onPaperChange,
    onPrepare,
    onMarkdown,
    onClose,
  }: {
    pending: boolean;
    selecting: boolean;
    messages: readonly ExportMessage[];
    onSelect: (index: number, selected: boolean) => void;
    onSelectAll: (selected: boolean) => void;
    onChooseMessages: () => void;
    onReload: () => void;
    error: string | null;
    prepared: PreparedExport | null;
    paper: PublicationPaper;
    onPaperChange: (paper: PublicationPaper) => void;
    onPrepare: () => void;
    onMarkdown: () => void;
    onClose: () => void;
  } = $props();

  const selectedCount = $derived(messages.filter((entry) => entry.selected).length);
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Conversation export">
  <div
    class="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 border-b border-ink-subtle px-4 py-3 md:px-10"
  >
    <Button
      variant="ghost"
      onclick={onClose}
      class="min-h-11 rounded-sm px-0 font-mono text-xs text-warm-faint"
    >
      <ArrowLeft size={14} /> Back to conversation
    </Button>
    <fieldset class="flex items-center gap-4 font-mono text-xs" disabled={pending}>
      <legend class="sr-only">Paper size</legend>
      <label class="flex min-h-11 cursor-pointer items-center gap-2"
        ><input
          type="radio"
          name="publication-paper"
          checked={paper === "a4"}
          onchange={() => onPaperChange("a4")}
          class="accent-gold"
        /> A4</label
      >
      <label class="flex min-h-11 cursor-pointer items-center gap-2"
        ><input
          type="radio"
          name="publication-paper"
          checked={paper === "us-letter"}
          onchange={() => onPaperChange("us-letter")}
          class="accent-gold"
        /> Letter</label
      >
    </fieldset>
    {#if !selecting}
      <Button
        variant="ghost"
        onclick={onChooseMessages}
        class="min-h-11 rounded-sm font-mono text-xs">Choose messages</Button
      >
    {/if}
    {#if prepared}
      <div class="flex flex-wrap items-center gap-3 sm:ml-auto">
        <Button variant="ghost" onclick={onPrepare} class="min-h-11 rounded-sm font-mono text-xs"
          >{prepared.format === "pdf" ? "Refresh copy" : "Try PDF again"}</Button
        >
        <Button
          variant="outline"
          href={prepared.markdownUrl}
          download={`${prepared.filename}.md`}
          class="min-h-11 rounded-sm font-mono text-xs">Markdown</Button
        >
        {#if prepared.format === "pdf"}
          <Button
            href={prepared.pdfUrl}
            download={`${prepared.filename}.pdf`}
            class="min-h-11 rounded-sm font-mono text-xs">Download PDF</Button
          >
        {/if}
      </div>
    {/if}
  </div>
  {#if pending}
    <div class="flex flex-1 items-center justify-center" role="status">
      <LoadingState label={selecting ? "Loading messages…" : "Preparing your reading copy…"} />
    </div>
  {:else if selecting}
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-10">
      <div class="mx-auto max-w-3xl">
        <h2 class="text-[length:var(--text-heading)]">Choose messages</h2>
        <p class="mt-2 text-[length:var(--text-caption)] text-warm-faint">
          Include any combination of your messages and agent replies, in conversation order.
        </p>
        {#if error}
          <p class="mt-6 text-warm-faint" role="alert">{error}</p>
          <Button
            variant="outline"
            onclick={onReload}
            class="mt-4 min-h-11 rounded-sm font-mono text-xs">Try again</Button
          >
        {:else if messages.length === 0}
          <p class="mt-6 text-warm-faint">No saved messages to export yet.</p>
        {:else}
          <div
            class="mt-5 flex flex-wrap items-center gap-x-4 border-b border-ink-subtle pb-2 font-mono text-xs"
          >
            <p class="mr-auto text-warm-faint" aria-live="polite">
              {selectedCount} of {messages.length} selected
            </p>
            <Button
              variant="ghost"
              onclick={() => onSelectAll(true)}
              class="min-h-11 rounded-sm font-mono text-xs">Select all</Button
            >
            <Button
              variant="ghost"
              onclick={() => onSelectAll(false)}
              class="min-h-11 rounded-sm font-mono text-xs">Clear all</Button
            >
          </div>
          <ol class="divide-y divide-ink-subtle">
            {#each messages as entry, index}
              <li class="flex items-start gap-3 py-3">
                <label
                  class="flex min-h-11 shrink-0 cursor-pointer items-center gap-2 font-mono text-xs"
                >
                  <input
                    type="checkbox"
                    checked={entry.selected}
                    onchange={(event) => onSelect(index, event.currentTarget.checked)}
                    aria-label={`Include ${entry.message.role === "user" ? "your message" : "agent reply"} ${index + 1}${entry.note ? " in attached note" : ""}`}
                    class="size-4 accent-gold"
                  />
                  <span class="w-12">{entry.message.role === "user" ? "You" : "Agent"}</span>
                </label>
                <details class="min-w-0 flex-1 py-2.5">
                  <summary
                    class="cursor-pointer text-[length:var(--text-caption)] [overflow-wrap:anywhere]"
                  >
                    {#if entry.note}<span class="mr-2 font-mono text-xs text-warm-faint">Note</span
                      >{/if}
                    {entry.text.length > 180
                      ? `${entry.text.slice(0, 180)}…`
                      : entry.text || "No saved text"}
                  </summary>
                  <p
                    class="mt-3 whitespace-pre-wrap text-[length:var(--text-caption)] leading-relaxed text-warm-faint [overflow-wrap:anywhere]"
                  >
                    {entry.text || "No saved text"}
                  </p>
                </details>
              </li>
            {/each}
          </ol>
        {/if}
      </div>
    </div>
    <div
      class="flex shrink-0 flex-wrap justify-end gap-3 border-t border-ink-subtle px-4 py-3 md:px-10"
    >
      <Button
        variant="outline"
        onclick={onMarkdown}
        disabled={selectedCount === 0}
        class="min-h-11 rounded-sm font-mono text-xs">Prepare Markdown</Button
      >
      <Button
        onclick={onPrepare}
        disabled={selectedCount === 0}
        class="min-h-11 rounded-sm font-mono text-xs">Prepare PDF</Button
      >
    </div>
  {:else if error}
    <div class="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-5 px-6">
      <h2 class="text-[length:var(--text-heading)]">Couldn’t prepare this copy</h2>
      <p class="text-warm-faint" role="alert">{error}</p>
      <div class="flex flex-wrap gap-3">
        <Button variant="outline" onclick={onPrepare} class="min-h-11 rounded-sm font-mono text-xs"
          >Try PDF again</Button
        >
        <Button variant="ghost" onclick={onMarkdown} class="min-h-11 rounded-sm font-mono text-xs"
          >Prepare Markdown</Button
        >
      </div>
      <p class="text-[length:var(--text-caption)] text-warm-faint">
        Markdown doesn’t need PDF rendering. It includes the same selected messages.
      </p>
    </div>
  {:else if prepared?.format === "markdown"}
    <div class="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-5 px-6">
      <h2 class="text-[length:var(--text-heading)]">Your Markdown copy is ready</h2>
      <p class="text-warm-faint">Your selected messages, in conversation order.</p>
      <Button
        href={prepared.markdownUrl}
        download={`${prepared.filename}.md`}
        class="min-h-11 w-fit rounded-sm font-mono text-xs">Download Markdown</Button
      >
    </div>
  {:else if prepared?.format === "pdf"}
    <div
      class="flex shrink-0 flex-wrap items-baseline justify-between gap-2 px-4 py-3 text-[length:var(--text-caption)] text-warm-faint md:px-10"
    >
      <p>
        {selectedCount} messages · Prepared {prepared.preparedAt.toLocaleString()}
      </p>
      <a
        href={prepared.pdfUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="text-gold underline underline-offset-4">Open PDF in a new tab</a
      >
    </div>
    <iframe
      src={prepared.pdfUrl}
      title={`PDF preview: ${prepared.title}`}
      class="min-h-0 w-full flex-1 border-0 bg-ink-raised"
    ></iframe>
  {/if}
</section>
