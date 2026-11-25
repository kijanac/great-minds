<script lang="ts">
  import { browser } from "$app/env";
  import type { Snippet } from "svelte";
  import { tick } from "svelte";

  import HastNodeView from "#lib/components/hast-node.svelte";
  import { buildFootnotePresentation, type FootnoteDefinitions } from "#lib/footnote-notes.ts";
  import type { MarkdownLinkClick } from "#lib/markdown-links.ts";
  import type { HastNode } from "#lib/markdown-plugins.ts";
  import { cn } from "#lib/utils.ts";

  export interface FootnoteRenderContext {
    footnoteMode: "margin" | "popover";
    footnoteDefinitions: FootnoteDefinitions;
    activeFootnote: string | null;
    onFootnoteHover: (id: string | null) => void;
    onFootnoteOpen: (id: string) => void;
  }

  let {
    roots,
    idPrefix,
    marginFootnotes = false,
    panelDocked = false,
    resetKey,
    onLinkClick,
    class: className,
    root = $bindable(null),
    children,
  }: {
    roots: readonly HastNode[];
    idPrefix: string;
    marginFootnotes?: boolean;
    panelDocked?: boolean;
    resetKey: string;
    onLinkClick?: MarkdownLinkClick;
    class?: string;
    root?: HTMLDivElement | null;
    children: Snippet<[FootnoteRenderContext]>;
  } = $props();

  let viewportWide = $state(false);
  let coarsePointer = $state(false);
  let hoveredFootnote = $state<string | null>(null);
  let leaving = 0;
  let notePositions = $state<Record<string, number>>({});

  const presentation = $derived(buildFootnotePresentation(roots, idPrefix));
  const visibleNotes = $derived(presentation.notes.filter((note) => note.id === hoveredFootnote));
  const marginEnabled = $derived(marginFootnotes && viewportWide && !coarsePointer && !panelDocked);

  $effect(() => {
    if (!browser || !marginFootnotes) return;
    const wide = window.matchMedia("(min-width: 1200px)");
    const coarse = window.matchMedia("(any-pointer: coarse)");
    const update = () => {
      viewportWide = wide.matches;
      coarsePointer = coarse.matches;
    };
    update();
    wide.addEventListener("change", update);
    coarse.addEventListener("change", update);
    return () => {
      wide.removeEventListener("change", update);
      coarse.removeEventListener("change", update);
    };
  });

  function measureAfterLayout(
    currentRoot: HTMLElement,
    place: (rootRect: DOMRect) => void,
  ): () => void {
    let frame = 0;
    const measure = async () => {
      await tick();
      frame = requestAnimationFrame(() => place(currentRoot.getBoundingClientRect()));
    };

    void measure();
    const observer = new ResizeObserver(() => void measure());
    observer.observe(currentRoot);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }

  $effect(() => {
    const currentRoot = root;
    const enabled = marginEnabled;
    const currentNotes = visibleNotes;
    if (!currentRoot || !enabled || currentNotes.length === 0) {
      notePositions = {};
      return;
    }

    return measureAfterLayout(currentRoot, (rootRect) => {
      const next: Record<string, number> = {};
      let cursor = 0;

      for (const note of currentNotes) {
        const reference = currentRoot.querySelector<HTMLElement>(
          `[data-margin-note-id="${CSS.escape(note.id)}"]`,
        );
        const block = reference?.closest<HTMLElement>("[data-footnote-block]") ?? reference;
        const noteElement = currentRoot.querySelector<HTMLElement>(
          `[data-margin-note="${CSS.escape(note.id)}"]`,
        );
        if (!block || !noteElement) continue;

        const desired = block.getBoundingClientRect().top - rootRect.top;
        const top = Math.max(desired, cursor);
        next[note.id] = top;
        cursor = top + noteElement.getBoundingClientRect().height + 8;
      }
      notePositions = next;
    });
  });

  $effect(() => {
    resetKey;
    hoveredFootnote = null;
  });

  $effect(() => {
    if (marginEnabled) return;
    hoveredFootnote = null;
  });

  function hover(id: string | null): void {
    clearTimeout(leaving);
    if (id !== null) hoveredFootnote = id;
    else leaving = window.setTimeout(() => (hoveredFootnote = null), 220);
  }

  function openFootnote(id: string): void {
    root?.querySelector<HTMLElement>(`[data-margin-note="${CSS.escape(id)}"] a[href]`)?.click();
    hoveredFootnote = null;
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !marginEnabled) return;
    hoveredFootnote = null;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div bind:this={root} class={cn("relative", className)}>
  {@render children({
    footnoteMode: marginEnabled ? "margin" : "popover",
    footnoteDefinitions: presentation.definitions,
    activeFootnote: hoveredFootnote,
    onFootnoteHover: hover,
    onFootnoteOpen: openFootnote,
  })}

  {#if marginEnabled}
    <div data-margin-notes class="pointer-events-none absolute inset-0 print:hidden">
      {#each visibleNotes as note (note.id)}
        <aside
          data-margin-note={note.id}
          onmouseenter={() => hover(note.id)}
          onmouseleave={() => hover(null)}
          class={`pointer-events-auto absolute left-[calc(100%+2rem)] w-[clamp(150px,calc((100vw-740px)/2-3rem),260px)] font-serif text-[length:var(--text-caption)] leading-[1.6] text-warm-dim transition-opacity ${note.id in notePositions ? "opacity-100" : "opacity-0"}`}
          style:top={`${notePositions[note.id] ?? 0}px`}
        >
          <HastNodeView
            node={note.content}
            variant="panel"
            {onLinkClick}
            footnoteMode="popover"
            footnoteDefinitions={presentation.definitions}
          />
        </aside>
      {/each}
    </div>
  {/if}
</div>
