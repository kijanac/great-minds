<script lang="ts">
  import { tick } from "svelte";

  import { findQuoteRange } from "$lib/anchor";
  import {
    wrapAnchors,
    type AnchorMark,
    type AnchorMiss,
  } from "$lib/anchor-marks";
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
    onBtwRetry,
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
    onBtwRetry?: (btwId: string, turnId: string) => void;
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

  // Only persisted threads become real <mark> elements; in-flight drafts
  // (thread not yet persisted) keep the transient painted highlight.
  const markAnchors = $derived.by<AnchorMark[]>(() =>
    bodyThreads
      .filter((btw) => !btw.draft)
      .map((btw) => ({
        threadId: btw.id,
        blockOffset: btw.anchor.blockOffset,
        quote: btw.anchor.quote,
      })),
  );
  // `stableTree` only depends on the stable prefix string. During token
  // streaming Svelte does not invalidate it until a complete block lands.
  // Settled trees carry marks; the streaming tail tree is never marked.
  const stableParsed = $derived.by(() =>
    stableSource
      ? parseSettled(stableSource)
      : { tree: emptyRoot(), misses: [] },
  );
  const stableTree = $derived(stableParsed.tree);
  const tailTree = $derived.by(() =>
    streaming && tailSource ? parseAnswer(tailSource) : emptyRoot(),
  );
  const fullParsed = $derived.by(() =>
    streaming ? { tree: emptyRoot(), misses: [] } : parseSettled(displayText),
  );
  const fullTree = $derived(fullParsed.tree);
  const anchorMisses = $derived(
    streaming ? stableParsed.misses : fullParsed.misses,
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
  // Gutter dots render only for threads whose block resolves in the body but
  // whose quote cannot be located in it — pure indicators, no interaction.
  // Threads with marks get no dot; threads with no block stay header-panel-only.
  const marginDots = $derived.by<MarginDot[]>(() => {
    const missedBlocks = new Set(
      anchorMisses
        .filter((miss) => miss.reason === "quote-not-found")
        .map((miss) => miss.blockOffset),
    );
    const seen = new Set<number>();
    const dots: MarginDot[] = [];
    for (const btw of bodyThreads) {
      if (btw.anchor.blockOffset < 0 || seen.has(btw.anchor.blockOffset))
        continue;
      if (!renderedOffsets.has(btw.anchor.blockOffset)) continue;
      if (!missedBlocks.has(btw.anchor.blockOffset)) continue;
      seen.add(btw.anchor.blockOffset);
      dots.push({
        id: `dot:${btw.anchor.blockOffset}`,
        blockOffset: btw.anchor.blockOffset,
        quote: btw.anchor.quote,
      });
    }
    return dots;
  });
  const footnoteRoots = $derived(
    streaming ? [stableTree, tailTree] : [fullTree],
  );

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
        // The painted path is transient decoration for in-flight drafts only;
        // persisted anchors are real <mark> elements in the settled tree.
        if (!btw.draft || !btw.anchor.quote) continue;
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

  // Settled trees carry real marks for persisted anchors; the miss report
  // feeds the fallback gutter dots via the active parse's derived value.
  function parseSettled(source: string): {
    tree: HastNode;
    misses: AnchorMiss[];
  } {
    const tree = parseAnswer(source);
    const { misses } = wrapAnchors(tree, markAnchors);
    return { tree, misses };
  }

  // Delegated click on the rendered body: a <mark data-thread-id> toggles its
  // thread's inline card. Selection wins — a mouseup that left a non-collapsed
  // selection is a selection, never a click-open.
  function handleBodyClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const mark = target.closest("mark[data-thread-id]");
    if (!mark) return;
    // A link inside a mark keeps its universal meaning: navigation wins,
    // the mark's non-link text is the toggle surface.
    const link = target.closest("a");
    if (link && mark.contains(link)) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) return;
    const threadId = mark.getAttribute("data-thread-id");
    if (!threadId) return;
    toggleThread(threadId);
  }

  // Hover highlights every segment of the hovered thread: a quote crossing
  // inline elements is split into sibling marks, and CSS :hover would only
  // tint the segment under the cursor.
  function setThreadHot(threadId: string, hot: boolean): void {
    if (!root) return;
    for (const segment of root.querySelectorAll(
      `mark[data-thread-id="${CSS.escape(threadId)}"]`,
    )) {
      segment.classList.toggle("btw-anchor-hot", hot);
    }
  }

  function handleBodyHover(event: MouseEvent, hot: boolean): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const mark = target.closest("mark[data-thread-id]");
    if (!mark) return;
    const related = event.relatedTarget;
    if (
      related instanceof Element &&
      related.closest("mark[data-thread-id]") === mark
    ) {
      return;
    }
    const threadId = mark.getAttribute("data-thread-id");
    if (threadId) setThreadHot(threadId, hot);
  }

  $effect(() => {
    const currentRoot = root;
    if (!currentRoot) return;
    const over = (event: MouseEvent) => handleBodyHover(event, true);
    const out = (event: MouseEvent) => handleBodyHover(event, false);
    currentRoot.addEventListener("click", handleBodyClick);
    currentRoot.addEventListener("mouseover", over);
    currentRoot.addEventListener("mouseout", out);
    return () => {
      currentRoot.removeEventListener("click", handleBodyClick);
      currentRoot.removeEventListener("mouseover", over);
      currentRoot.removeEventListener("mouseout", out);
    };
  });

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
              onRetry={onBtwRetry}
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
