<script lang="ts">
  import { browser } from "$app/environment";
  import { tick } from "svelte";

  import { findQuoteRange } from "$lib/anchor";
  import BtwThread from "$lib/components/btw-thread.svelte";
  import HastNodeView from "$lib/components/hast-node.svelte";
  import { clearAnchorHighlights, setAnchorHighlights } from "$lib/highlight";
  import { parseMarkdown } from "$lib/markdown";
  import type { HastNode } from "$lib/markdown-plugins";
  import { splitStreamingMarkdown } from "$lib/streaming-markdown";
  import type { BtwThread as BtwThreadType, SelectionInfo } from "$lib/types";

  let {
    text,
    exchangeId,
    btws,
    streaming,
    panelDocked = false,
    onSelection,
    onBtwReply,
    onBtwDismiss,
    onBtwSpinOff,
    onLinkClick,
    variant = "answer",
    marginFootnotes = true,
    stripBlockRefs = false,
    resolveBlockRefs = false,
  }: {
    text: string;
    exchangeId: string;
    btws: BtwThreadType[];
    streaming: boolean;
    panelDocked?: boolean;
    onSelection: (info: SelectionInfo) => void;
    onBtwReply: (btwId: string, text: string) => void;
    onBtwDismiss?: (btwId: string) => void;
    onBtwSpinOff?: (btwId: string) => void;
    onLinkClick?: (event: MouseEvent) => void;
    variant?: "answer" | "article";
    marginFootnotes?: boolean;
    stripBlockRefs?: boolean;
    resolveBlockRefs?: boolean;
  } = $props();

  let root: HTMLDivElement | null = $state(null);
  let viewportWide = $state(false);
  let coarsePointer = $state(false);
  let activeFootnote = $state<string | null>(null);
  let notePositions = $state<Record<string, number>>({});

  const BLOCK_REF_RE = /\s*\^p\d+(?=\n|$)/gm;
  const displayText = $derived(
    stripBlockRefs ? text.replace(BLOCK_REF_RE, "") : text,
  );
  const split = $derived(
    streaming ? splitStreamingMarkdown(displayText) : null,
  );
  const stableSource = $derived(split?.stable ?? "");
  const tailSource = $derived(split?.tail ?? "");

  // `stableTree` only depends on the stable prefix string. During token
  // streaming Svelte does not invalidate it until a complete block lands.
  const stableTree = $derived.by(() =>
    stableSource ? parseAnswer(stableSource, "stable") : emptyRoot(),
  );
  const tailTree = $derived.by(() =>
    streaming && tailSource ? parseAnswer(tailSource, "tail") : emptyRoot(),
  );
  const fullTree = $derived.by(() =>
    streaming ? emptyRoot() : parseAnswer(displayText, "full"),
  );
  const renderedOffsets = $derived.by(() => {
    const tree = streaming ? null : fullTree;
    return new Set(
      (tree?.children ?? [])
        .map((node) => node.position?.start?.offset)
        .filter((offset): offset is number => offset != null),
    );
  });
  const orphanedBtws = $derived(
    btws.filter((btw) => !renderedOffsets.has(btw.anchor.blockOffset)),
  );
  const notes = $derived.by(() => {
    const trees = streaming ? [stableTree, tailTree] : [fullTree];
    return trees.flatMap(collectMarginNotes);
  });
  const marginEnabled = $derived(
    marginFootnotes && viewportWide && !coarsePointer && !panelDocked,
  );

  $effect(() => {
    if (!browser) return;
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
    const currentBtws = btws;
    const currentText = text;
    if (!currentRoot) return;

    void currentText;
    let cancelled = false;
    void tick().then(() => {
      if (cancelled) return;
      const ranges: Range[] = [];
      for (const btw of currentBtws) {
        const block = currentRoot.querySelector<HTMLElement>(
          `[data-block-offset="${btw.anchor.blockOffset}"]`,
        );
        if (!block) continue;
        const range = findQuoteRange(block, btw.anchor.quote);
        if (range) ranges.push(range);
      }
      setAnchorHighlights(exchangeId, ranges);
    });
    return () => {
      cancelled = true;
      clearAnchorHighlights(exchangeId);
    };
  });

  $effect(() => {
    const currentRoot = root;
    const currentNotes = notes;
    const enabled = marginEnabled;
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

  function emptyRoot(): HastNode {
    return { type: "root", children: [] };
  }

  function parseAnswer(source: string, prefix: string): HastNode {
    const tree = parseMarkdown(source);
    let index = 0;
    const walk = (node: HastNode): void => {
      if (
        node.tagName === "a" &&
        node.properties?.dataFootnoteRef === true &&
        typeof node.properties.dataFootnoteContent === "string"
      ) {
        node.properties.dataMarginNoteId = `${exchangeId}-${prefix}-fn-${index++}`;
      }
      node.children?.forEach(walk);
    };
    walk(tree);
    if (stripBlockRefs && resolveBlockRefs) {
      assignBlockRefIds(tree, text);
    }
    return tree;
  }

  function assignBlockRefIds(tree: HastNode, originalSource: string): void {
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

    const anchoredTags = new Set([
      "h1",
      "h2",
      "h3",
      "p",
      "ul",
      "ol",
      "blockquote",
    ]);
    const claimed = new Set<number>();
    const walk = (node: HastNode): void => {
      if (
        node.type === "element" &&
        node.tagName &&
        anchoredTags.has(node.tagName)
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
    walk(tree);
  }

  function collectMarginNotes(
    tree: HastNode,
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
    walk(tree);
    return found;
  }

  function handleSelect(event: MouseEvent, offset: number): void {
    if (streaming) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0)
      return;
    const quote = selection.toString().trim();
    if (quote.length < 5) return;
    const range = selection.getRangeAt(0);
    const element = event.currentTarget as HTMLElement;
    if (!element.contains(range.commonAncestorContainer)) return;
    event.stopPropagation();
    const rect = range.getBoundingClientRect();
    onSelection({
      blockOffset: offset,
      quote,
      context: element.textContent ?? "",
      x: rect.left + rect.width / 2,
      y: rect.top - 6,
      exchangeId,
    });
  }
</script>

<div bind:this={root} class="relative select-text">
  {#if streaming}
    {#each stableTree.children ?? [] as node, index (node.position?.start?.offset == null ? `fallback:${index}` : `offset:${node.position.start.offset}`)}
      {@const offset = node.position?.start?.offset}
      <HastNodeView
        {node}
        {variant}
        blockOffset={offset}
        topLevel
        onBlockMouseUp={handleSelect}
        {onLinkClick}
        footnoteMode={marginEnabled ? "margin" : "popover"}
        {activeFootnote}
        onFootnoteHover={(id) => (activeFootnote = id)}
      />
    {/each}
    {#each tailTree.children ?? [] as node, index (node.position?.start?.offset == null ? `fallback:${index}` : `offset:${node.position.start.offset}`)}
      {@const offset = node.position?.start?.offset}
      <HastNodeView
        {node}
        {variant}
        blockOffset={offset}
        topLevel
        onBlockMouseUp={handleSelect}
        {onLinkClick}
        footnoteMode={marginEnabled ? "margin" : "popover"}
        {activeFootnote}
        onFootnoteHover={(id) => (activeFootnote = id)}
      />
    {/each}
  {:else}
    {#each fullTree.children ?? [] as node, index (node.position?.start?.offset == null ? `fallback:${index}` : `offset:${node.position.start.offset}`)}
      {@const offset = node.position?.start?.offset}
      <HastNodeView
        {node}
        {variant}
        blockOffset={offset}
        topLevel
        onBlockMouseUp={handleSelect}
        {onLinkClick}
        footnoteMode={marginEnabled ? "margin" : "popover"}
        {activeFootnote}
        onFootnoteHover={(id) => (activeFootnote = id)}
      />
      {#if offset != null}
        {#each btws.filter((btw) => btw.anchor.blockOffset === offset) as btw (btw.id)}
          <BtwThread
            {btw}
            onReply={onBtwReply}
            onDismiss={onBtwDismiss}
            onSpinOff={onBtwSpinOff}
          />
        {/each}
      {/if}
    {/each}
  {/if}

  {#if streaming}
    <span
      class="ml-px inline-block h-[13px] w-0.5 animate-[blink_1s_step-end_infinite] bg-gold align-middle"
    ></span>
  {/if}

  {#each orphanedBtws as btw (btw.id)}
    <BtwThread
      {btw}
      onReply={onBtwReply}
      onDismiss={onBtwDismiss}
      onSpinOff={onBtwSpinOff}
    />
  {/each}

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
