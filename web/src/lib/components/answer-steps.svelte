<script lang="ts">
  import { plural } from "@great-minds/client";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";

  import type { SourceRef, ThinkingBlock } from "#lib/types.ts";
  import { displayTitle } from "#lib/utils.ts";

  let {
    blocks,
    streaming,
    onOpen,
  }: {
    blocks: readonly ThinkingBlock[];
    streaming: boolean;
    onOpen: (source: SourceRef) => void;
  } = $props();

  let open = $state(false);
  const steps = $derived(blocks.flatMap((block) => block.sources));
  const reads = (type: SourceRef["type"]) =>
    new Set(
      steps.filter((step) => step.type === type).map((step) => step.label),
    ).size;
  const articles = $derived(reads("article"));
  const sources = $derived(reads("raw"));
  const current = $derived(steps.at(-1));
  const readSoFar = $derived(articles + sources);

  const filterLabel = (label: string) =>
    /^contains: (.*?)(, sort:.*)?$/.exec(label)?.[1] ?? label;

  const verb = (step: SourceRef) =>
    step.type === "search"
      ? step.scope === "web"
        ? "searched the web for"
        : "searched"
      : step.type === "query"
        ? "listed articles about"
        : step.type === "article"
          ? "read article"
          : step.type === "raw"
            ? "read source"
            : "followed links from";

  const object = (step: SourceRef) =>
    step.type === "search" || step.type === "query"
      ? `“${step.type === "query" ? filterLabel(step.label) : step.label}”`
      : displayTitle(step.label, step.title);

  const readable = (step: SourceRef) =>
    step.pending !== true &&
    (step.type === "article" || step.type === "raw" || step.type === "links");
</script>

{#snippet stepLine(step: SourceRef)}
  <span>{verb(step)}</span>
  {#if readable(step)}
    <button
      type="button"
      onclick={() => onOpen(step)}
      class="font-serif text-[length:var(--text-small)] text-warm-faint italic underline decoration-ink-border underline-offset-[3px] hover:text-warm-dim"
      >{object(step)}</button
    >
  {:else}
    <span
      class={step.type === "article" || step.type === "raw"
        ? "font-serif text-[length:var(--text-small)] text-warm-faint italic"
        : ""}>{object(step)}</span
    >
  {/if}
{/snippet}

{#if streaming}
  <div
    role="status"
    class="mb-6 font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost"
  >
    <div class="flex min-h-5 flex-wrap items-baseline gap-x-1.5">
      <span
        class="mr-1 inline-block size-1.5 shrink-0 animate-[pulse-fade_1.6s_ease-in-out_infinite] self-center rounded-full bg-gold"
      ></span>
      {#if current}
        {@render stepLine(current)}
      {:else}
        <span>reading the library…</span>
      {/if}
    </div>
    {#if steps.length > 0}
      <div class="mt-1 text-gold-muted">
        {plural(steps.length, "step")} · {readSoFar} read so far
      </div>
    {/if}
  </div>
{:else if steps.length > 0}
  <div
    class="mb-7 font-mono text-[length:var(--text-chrome)] tracking-[0.04em] text-warm-ghost"
  >
    <button
      type="button"
      onclick={() => (open = !open)}
      aria-expanded={open}
      class="inline-flex flex-wrap items-center gap-x-1.5 text-left hover:text-warm-faint"
    >
      <span
        >{articles + sources === 0
          ? "Answered without reading the library"
          : `Answered from ${plural(articles, "article")} and ${plural(sources, "source")}`}</span
      >
      <span class="text-ink-border">·</span>
      <span class="inline-flex items-center gap-0.5 text-gold-muted"
        >{plural(steps.length, "step")}<ChevronRight
          size={12}
          class={`transition-transform ${open ? "rotate-90" : ""}`}
        /></span
      >
    </button>
    {#if open}
      <ol
        class="mt-3 max-h-64 space-y-1 overflow-y-auto border-l border-ink-subtle py-1 pl-3.5 leading-[1.7]"
      >
        {#each steps as step, index (`${step.type}:${index}:${step.label}`)}
          <li class="flex flex-wrap items-baseline gap-x-1.5">
            {@render stepLine(step)}
          </li>
        {/each}
      </ol>
    {/if}
  </div>
{/if}
