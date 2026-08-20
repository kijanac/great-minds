import type { HastNode } from "$lib/markdown-plugins";

export interface AnchorMark {
  threadId: string;
  blockOffset: number;
  quote: string;
}

export type AnchorMissReason = "no-block" | "quote-not-found";

export interface AnchorMiss {
  threadId: string;
  blockOffset: number;
  quote: string;
  reason: AnchorMissReason;
}

export interface WrapAnchorsResult {
  tree: HastNode;
  misses: AnchorMiss[];
}

// The mark class styled in index.css via the --btw token; hover + cursor
// come from the same rule. Only this class is added to the tree; the
// `data-thread-id` attribute is what the delegated click handler keys on.
const MARK_CLASS = "btw-anchor-mark";

/** Find the top-level block carrying the given source offset.
 *
 * Block identity is the block's source start offset (the same value that
 * `answer-block.svelte` forwards as the `data-block-offset` render prop and
 * that anchors carry from the server as `paragraph_index`).
 */
function findBlock(tree: HastNode, blockOffset: number): HastNode | null {
  for (const child of tree.children ?? []) {
    if (child.type === "element" && child.position?.start?.offset === blockOffset) {
      return child;
    }
  }
  return null;
}

/** Map a quote match back to text nodes via cumulative offsets.
 *
 * Returns the half-open [start, end) span in the block's concatenated text.
 * The concatenation is the same normalization the DOM-side `findQuoteRange`
 * applies (plain textContent join, first occurrence), so both paths agree on
 * what counts as "located".
 */
function findQuoteSpan(block: HastNode, quote: string): { start: number; end: number } | null {
  if (!quote) return null;
  const full = collectText(block);
  const idx = full.indexOf(quote);
  if (idx < 0) return null;
  return { start: idx, end: idx + quote.length };
}

function collectText(block: HastNode): string {
  let out = "";
  const walk = (node: HastNode): void => {
    if (node.type === "text") {
      out += node.value ?? "";
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(block);
  return out;
}

/** SPLIT each text node intersected by [start, end) and wrap each segment in
 * its own <mark> sharing `data-thread-id`. Works in one pass with a running
 * cursor; text content is unchanged, so sequential quote searches still
 * resolve against the same offsets (overlapping quotes nest marks). */
function applyWrap(block: HastNode, threadId: string, start: number, end: number): void {
  const mark = (value: string): HastNode => ({
    type: "element",
    tagName: "mark",
    properties: {
      className: [MARK_CLASS],
      dataThreadId: threadId,
    },
    children: [{ type: "text", value }],
  });

  const rewrite = (node: HastNode, cursor: number): { out: HastNode[]; cursor: number } => {
    if (node.type === "text") {
      const value = node.value ?? "";
      const len = value.length;
      const nodeStart = cursor;
      const nodeEnd = cursor + len;
      if (nodeEnd <= start || nodeStart >= end) {
        return { out: [node], cursor: nodeEnd };
      }
      const s = Math.max(nodeStart, start) - nodeStart;
      const e = Math.min(nodeEnd, end) - nodeStart;
      const out: HastNode[] = [];
      if (s > 0) out.push({ type: "text", value: value.slice(0, s) });
      out.push(mark(value.slice(s, e)));
      if (e < len) out.push({ type: "text", value: value.slice(e) });
      return { out, cursor: nodeEnd };
    }
    // Elements keep their identity as containers; only their children are
    // rewritten, so inline structure survives (and overlapping quotes nest).
    const out: HastNode[] = [];
    let c = cursor;
    for (const child of node.children ?? []) {
      const result = rewrite(child, c);
      out.push(...result.out);
      c = result.cursor;
    }
    node.children = out;
    return { out: [node], cursor: c };
  };

  const out: HastNode[] = [];
  let cursor = 0;
  for (const child of block.children ?? []) {
    const result = rewrite(child, cursor);
    out.push(...result.out);
    cursor = result.cursor;
  }
  block.children = out;
}

/** Wrap every locatable anchor in the settled tree as <mark> elements.
 *
 * Mutates `tree` in place. Anchors whose block is absent from the tree or
 * whose quote cannot be located in it are reported in `misses` so the caller
 * can render the fallback gutter dot. Apply threads sequentially: wrapping
 * never changes text content, so later quotes still resolve; overlaps
 * produce nested marks (the tint uses alpha so nesting darkens).
 */
export function wrapAnchors(tree: HastNode, anchors: AnchorMark[]): WrapAnchorsResult {
  const misses: AnchorMiss[] = [];
  for (const anchor of anchors) {
    const block = findBlock(tree, anchor.blockOffset);
    if (!block) {
      misses.push({
        threadId: anchor.threadId,
        blockOffset: anchor.blockOffset,
        quote: anchor.quote,
        reason: "no-block",
      });
      continue;
    }
    const span = findQuoteSpan(block, anchor.quote);
    if (!span) {
      misses.push({
        threadId: anchor.threadId,
        blockOffset: anchor.blockOffset,
        quote: anchor.quote,
        reason: "quote-not-found",
      });
      continue;
    }
    applyWrap(block, anchor.threadId, span.start, span.end);
  }
  return { tree, misses };
}
