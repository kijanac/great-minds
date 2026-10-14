<script lang="ts">
  import type { PublicationPaper } from "@great-minds/domain";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import { Button } from "$lib/components/ui/button";
  import { LoadingState } from "$lib/components/ui/feedback";
  import type { PreparedExport } from "$lib/hooks/use-session-export.svelte";

  let {
    pending,
    error,
    prepared,
    paper,
    onPaperChange,
    onPrepare,
    onMarkdown,
    onClose,
  }: {
    pending: boolean;
    error: string | null;
    prepared: PreparedExport | null;
    paper: PublicationPaper;
    onPaperChange: (paper: PublicationPaper) => void;
    onPrepare: () => void;
    onMarkdown: () => void;
    onClose: () => void;
  } = $props();
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
    <fieldset
      class="flex items-center gap-4 font-mono text-xs"
      disabled={pending}
    >
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
    {#if prepared}
      <div class="flex flex-wrap items-center gap-3 sm:ml-auto">
        <Button
          variant="ghost"
          onclick={onPrepare}
          class="min-h-11 rounded-sm font-mono text-xs"
          >{prepared.format === "pdf"
            ? "Refresh copy"
            : "Try PDF again"}</Button
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
      <LoadingState label="Preparing your reading copy…" />
    </div>
  {:else if error}
    <div
      class="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-5 px-6"
    >
      <h2 class="text-[length:var(--text-heading)]">
        Couldn’t prepare this copy
      </h2>
      <p class="text-warm-faint" role="alert">{error}</p>
      <div class="flex flex-wrap gap-3">
        <Button
          variant="outline"
          onclick={onPrepare}
          class="min-h-11 rounded-sm font-mono text-xs">Try PDF again</Button
        >
        <Button
          variant="ghost"
          onclick={onMarkdown}
          class="min-h-11 rounded-sm font-mono text-xs">Prepare Markdown</Button
        >
      </div>
      <p class="text-[length:var(--text-caption)] text-warm-faint">
        Markdown doesn’t need PDF rendering. It reads a fresh copy of the saved
        conversation and attached notes, without leaving anything out.
      </p>
    </div>
  {:else if prepared?.format === "markdown"}
    <div
      class="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-5 px-6"
    >
      <h2 class="text-[length:var(--text-heading)]">
        Your Markdown copy is ready
      </h2>
      <p class="text-warm-faint">
        The saved conversation and attached notes, read afresh.
      </p>
      <Button
        href={prepared.markdownUrl}
        download={`${prepared.filename}.md`}
        class="min-h-11 w-fit rounded-sm font-mono text-xs"
        >Download Markdown</Button
      >
    </div>
  {:else if prepared?.format === "pdf"}
    <div
      class="flex shrink-0 flex-wrap items-baseline justify-between gap-2 px-4 py-3 text-[length:var(--text-caption)] text-warm-faint md:px-10"
    >
      <p>
        Saved conversation and attached notes · Prepared {prepared.preparedAt.toLocaleString()}
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
