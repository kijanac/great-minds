<script lang="ts">
  import { browser } from "$app/environment";
  import { tick } from "svelte";

  import HastNodeView from "$lib/components/hast-node.svelte";
  import { parseMarkdown } from "$lib/markdown";
  import type { HastNode } from "$lib/markdown-plugins";

  let {
    source,
    variant = "article",
    stripBlockRefs = false,
    resolveBlockRefs = false,
    onLinkClick,
    marginFootnotes = false,
    panelDocked = false,
  }: {
    source: string;
    variant?: "panel" | "article" | "answer" | "btw";
    stripBlockRefs?: boolean;
    resolveBlockRefs?: boolean;
    onLinkClick?: (event: MouseEvent) => void;
    marginFootnotes?: boolean;
    panelDocked?: boolean;
  } = $props();

  const BLOCK_REF_RE = /\s*\^p\d+(?=\n|$)/gm;
  const ANCHORED_TAGS = new Set([
    "h1",
    "h2",
    "h3",
    "p",
    "ul",
    "ol",
    "blockquote",
  ]);

  const displaySource = $derived(
    stripBlockRefs ? source.replace(BLOCK_REF_RE, "") : source,
  );
  const tree = $derived.by(() => {
    const rendered = parseMarkdown(displaySource);
    if (stripBlockRefs && resolveBlockRefs) {
      assignBlockRefIds(rendered, source);
    }
    assignMarginNoteIds(rendered);
    return rendered;
  });

  let root: HTMLDivElement | null = $state(null);
  let viewportWide = $state(false);
  let coarsePointer = $state(false);
  let activeFootnote = $state<string | null>(null);
  let notePositions = $state<Record<string, number>>({});
  const notes = $derived(collectMarginNotes(tree));
  const marginEnabled = $derived(
    marginFootnotes && viewportWide && !coarsePointer && !panelDocked,
  );

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

  $effect(() => {
    const currentRoot = root;
    const enabled = marginEnabled;
    const currentNotes = notes;
    if (!currentRoot || !enabled || currentNotes.length === 0) {
      notePositions = {};
      return;
    }

    let frame = 0;
    const measure = async () => {
      await tick();
      frame = requestAnimationFrame(() => {
        const rootRect = currentRoot.getBoundingClientRect();
        const next: Record<string, number> = {};
        let cursor = 0;

        for (const note of currentNotes) {
          const reference = currentRoot.querySelector<HTMLElement>(
            `[data-margin-note-id="${CSS.escape(note.id)}"]`,
          );
          const block =
            reference?.closest<HTMLElement>("[data-footnote-block]") ??
            reference;
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
  });

  function assignMarginNoteIds(rootNode: HastNode): void {
    let index = 0;
    const walk = (node: HastNode): void => {
      if (
        node.tagName === "a" &&
        node.properties?.dataFootnoteRef === true &&
        typeof node.properties.dataFootnoteContent === "string"
      ) {
        node.properties.dataMarginNoteId = `fn-margin-${index++}`;
      }
      node.children?.forEach(walk);
    };
    walk(rootNode);
  }

  function collectMarginNotes(
    rootNode: HastNode,
  ): { id: string; content: string }[] {
    const found: { id: string; content: string }[] = [];
    const walk = (node: HastNode): void => {
      const id = node.properties?.dataMarginNoteId;
      const content = node.properties?.dataFootnoteContent;
      if (typeof id === "string" && typeof content === "string") {
        found.push({ id, content });
      }
      node.children?.forEach(walk);
    };
    walk(rootNode);
    return found;
  }

  function assignBlockRefIds(root: HastNode, originalSource: string): void {
    const markers: { position: number; chunk: number }[] = [];
    const markerPattern = /\s*\^p(\d+)(?=\n|$)/gm;
    let removed = 0;
    let match: RegExpExecArray | null;

    while ((match = markerPattern.exec(originalSource)) !== null) {
      markers.push({
        position: match.index - removed,
        chunk: Number(match[1]),
      });
      removed += match[0].length;
    }

    const claimed = new Set<number>();
    const walk = (node: HastNode): void => {
      if (
        node.type === "element" &&
        node.tagName &&
        ANCHORED_TAGS.has(node.tagName)
      ) {
        const start = node.position?.start?.offset;
        const end = node.position?.end?.offset;
        if (start != null && end != null) {
          const marker = markers.find(
            (candidate) =>
              !claimed.has(candidate.chunk) &&
              candidate.position >= start &&
              candidate.position <= end + 1,
          );
          if (marker) {
            claimed.add(marker.chunk);
            node.properties = {
              ...node.properties,
              id: `^p${marker.chunk}`,
            };
          }
        }
      }
      node.children?.forEach(walk);
    };
    walk(root);
  }
</script>

<div bind:this={root} class="relative">
  <HastNodeView
    node={tree}
    {variant}
    {onLinkClick}
    footnoteMode={marginEnabled ? "margin" : "popover"}
    {activeFootnote}
    onFootnoteHover={(id) => (activeFootnote = id)}
  />

  {#if marginEnabled}
    <div class="pointer-events-none absolute inset-0 print:hidden">
      {#each notes as note (note.id)}
        <aside
          data-margin-note={note.id}
          class={`pointer-events-auto absolute left-[calc(100%+2rem)] w-[clamp(150px,calc((100vw-740px)/2-3rem),260px)] font-serif text-[length:var(--text-caption)] leading-[1.6] transition-colors ${
            activeFootnote === note.id ? "text-warm-dim" : "text-warm-ghost"
          } ${note.id in notePositions ? "opacity-100" : "opacity-0"}`}
          style:top={`${notePositions[note.id] ?? 0}px`}
          onmouseenter={() => (activeFootnote = note.id)}
          onmouseleave={() => (activeFootnote = null)}
        >
          {note.content}
        </aside>
      {/each}
    </div>
  {/if}
</div>
