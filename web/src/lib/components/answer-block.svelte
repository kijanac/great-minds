<script lang="ts">
  import { tick } from "svelte";

  import { findQuoteRange } from "$lib/anchor";
  import BtwThread from "$lib/components/btw-thread.svelte";
  import FootnoteNotes, {
    type MarginDot,
  } from "$lib/components/footnote-notes.svelte";
  import HastNodeView from "$lib/components/hast-node.svelte";
  import { clearAnchorHighlights, setAnchorHighlights } from "$lib/highlight";
  import { parseMarkdown } from "$lib/markdown";
  import type { HastNode } from "$lib/markdown-plugins";
  import { splitStreamingMarkdown } from "$lib/streaming-markdown";
  import type { SelectionInfo, ThreadLike } from "$lib/types";

  let {
    text,
    exchangeId,
    btws,
    streaming,
    panelDocked = false,
    onSelection,
    onBtwReply,
    onBtwDismiss,
    onBtwOpenSession,
    onLinkClick,
    variant = "answer",
    marginFootnotes = true,
    stripBlockRefs = false,
    resolveBlockRefs = false,
    readOnly = false,
    expandedThreads = null,
    onToggleThread,
  }: {
    text: string;
    exchangeId: string;
    btws: ThreadLike[];
    streaming: boolean;
    panelDocked?: boolean;
    onSelection?: (info: SelectionInfo) => void;
    onBtwReply?: (btwId: string, text: string) => void;
    onBtwDismiss?: (btwId: string) => void;
    onBtwOpenSession?: (btwId: string) => void;
    onLinkClick?: (event: MouseEvent) => void;
    variant?: "answer" | "article";
    marginFootnotes?: boolean;
    stripBlockRefs?: boolean;
    resolveBlockRefs?: boolean;
    readOnly?: boolean;
    // When provided, thread expansion is controlled externally (reader chip /
    // DocThreads); otherwise AnswerBlock owns a local expansion map.
    expandedThreads?: Set<string> | null;
    onToggleThread?: (btwId: string) => void;
  } = $props();

  let root: HTMLDivElement | null = $state(null);
  let localExpanded = $state<Record<string, boolean>>({});

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
    stableSource ? parseAnswer(stableSource) : emptyRoot(),
  );
  const tailTree = $derived.by(() =>
    streaming && tailSource ? parseAnswer(tailSource) : emptyRoot(),
  );
  const fullTree = $derived.by(() =>
    streaming ? emptyRoot() : parseAnswer(displayText),
  );
  // Offsets of top-level blocks currently rendered in the body (streaming
  // uses the stable/tail trees, otherwise the full tree). Threads whose
  // anchor offset is not among these are unresolvable: they render nowhere
  // in the body (no inline thread, no gutter dot) but stay reachable from
  // the header panel's notes list.
  const renderedOffsets = $derived.by(() => {
    const tree = streaming ? [stableTree, tailTree] : [fullTree];
    return new Set(
      tree
        .flatMap((t) => t.children ?? [])
        .map((node) => node.position?.start?.offset)
        .filter((offset): offset is number => offset != null),
    );
  });
  // Only anchored threads (quote present) render in the body; doc-initiated
  // conversations surface through the doc-header chip instead.
  const bodyThreads = $derived(
    btws.filter((btw) => btw.anchor.quote.length > 0),
  );
  const footnoteRoots = $derived(
    streaming ? [stableTree, tailTree] : [fullTree],
  );
  const marginDots = $derived.by<MarginDot[]>(() => {
    const seen = new Set<number>();
    const dots: MarginDot[] = [];
    for (const btw of bodyThreads) {
      if (btw.anchor.blockOffset < 0 || seen.has(btw.anchor.blockOffset))
        continue;
      if (!renderedOffsets.has(btw.anchor.blockOffset)) continue;
      seen.add(btw.anchor.blockOffset);
      dots.push({
        id: `dot:${btw.anchor.blockOffset}`,
        blockOffset: btw.anchor.blockOffset,
        quote: btw.anchor.quote,
      });
    }
    return dots;
  });

  const isOpen = (btwId: string): boolean =>
    expandedThreads
      ? expandedThreads.has(btwId)
      : (localExpanded[btwId] ?? false);

  const toggleThread = (btwId: string): void => {
    if (expandedThreads) {
      onToggleThread?.(btwId);
      return;
    }
    localExpanded = {
      ...localExpanded,
      [btwId]: !(localExpanded[btwId] ?? false),
    };
  };

  // Locally-managed threads (session BTWs, share page) open on arrival unless
  // read-only; reader threads are controlled by DocThreads instead.
  $effect(() => {
    if (expandedThreads) return;
    let changed = false;
    const next = { ...localExpanded };
    for (const btw of btws) {
      if (btw.id in next) continue;
      next[btw.id] = !readOnly;
      changed = true;
    }
    if (changed) localExpanded = next;
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
        if (!btw.anchor.quote) continue;
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

  function handleDotClick(dot: MarginDot) {
    for (const btw of bodyThreads) {
      if (btw.anchor.blockOffset === dot.blockOffset) toggleThread(btw.id);
    }
  }

  function emptyRoot(): HastNode {
    return { type: "root", children: [] };
  }

  function parseAnswer(source: string): HastNode {
    const tree = parseMarkdown(source);
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

  function handleSelect(event: MouseEvent, offset: number): void {
    if (streaming || !onSelection) return;
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

<FootnoteNotes
  bind:root
  roots={footnoteRoots}
  idPrefix={`${exchangeId}-fn`}
  {marginFootnotes}
  {panelDocked}
  resetKey={`${streaming}:${displayText}`}
  {onLinkClick}
  {marginDots}
  onDotClick={handleDotClick}
  class="select-text"
>
  {#snippet children({
    footnoteMode,
    footnoteDefinitions,
    activeFootnote,
    pinnedFootnotes,
    onFootnoteHover,
    onFootnoteToggle,
  })}
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
          {footnoteMode}
          {footnoteDefinitions}
          {activeFootnote}
          {pinnedFootnotes}
          {onFootnoteHover}
          {onFootnoteToggle}
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
          {footnoteMode}
          {footnoteDefinitions}
          {activeFootnote}
          {pinnedFootnotes}
          {onFootnoteHover}
          {onFootnoteToggle}
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
          {footnoteMode}
          {footnoteDefinitions}
          {activeFootnote}
          {pinnedFootnotes}
          {onFootnoteHover}
          {onFootnoteToggle}
        />
        {#if offset != null}
          {#each bodyThreads.filter((btw) => btw.anchor.blockOffset === offset) as btw (btw.id)}
            <BtwThread
              {btw}
              open={isOpen(btw.id)}
              onOpenChange={onToggleThread
                ? () => onToggleThread(btw.id)
                : () => toggleThread(btw.id)}
              hideWhenClosed
              {readOnly}
              onReply={onBtwReply}
              onDismiss={onBtwDismiss}
              onOpenSession={onBtwOpenSession}
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
  {/snippet}
</FootnoteNotes>
