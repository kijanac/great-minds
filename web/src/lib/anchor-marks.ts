import { quoteMatches, sectionOf } from "#lib/anchor.ts";
import type { HastNode } from "#lib/markdown-plugins.ts";
import type { TextAnchor } from "#lib/types.ts";

export interface ThreadAnchor {
  threadId: string;
  anchor: TextAnchor;
  mark: boolean;
}

export interface Placement {
  offset: number;
  start: number;
  end: number;
}

const MARK_CLASS = "btw-anchor-mark";

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

function blockSection(block: HastNode): number | null {
  const own = sectionOf(block.properties?.id);
  if (own !== null) return own;
  const first = block.children?.find((child) => child.type === "element");
  return first?.tagName === "span" ? sectionOf(first.properties?.id) : null;
}

export function resolvePassage(
  blocks: readonly HastNode[],
  anchor: TextAnchor,
): (Placement & { block: HastNode }) | null {
  const { quote } = anchor;
  if (!quote) return null;
  const at = (block: HastNode, start: number) => ({
    block,
    offset: block.position?.start?.offset ?? -1,
    start,
    end: start + quote.length,
  });
  if (anchor.occurrence !== null) {
    let scope = blocks;
    if (anchor.section !== null) {
      const from = blocks.findIndex((block) => blockSection(block) === anchor.section);
      const to = blocks.findIndex((block, index) => index > from && blockSection(block) !== null);
      scope = from < 0 ? [] : blocks.slice(from, to < 0 ? undefined : to);
    }
    let seen = 0;
    for (const block of scope)
      for (const start of quoteMatches(collectText(block), quote))
        if (++seen === anchor.occurrence) return at(block, start);
  }
  let found: (Placement & { block: HastNode }) | null = null;
  for (const block of blocks)
    for (const start of quoteMatches(collectText(block), quote)) {
      if (found) return null;
      found = at(block, start);
    }
  return found;
}

/** SPLIT each text node intersected by [start, end) and wrap each segment in
 * its own <mark> sharing `data-thread-id`. Works in one pass with a running
 * cursor; text content is unchanged, so sequential quote searches still
 * resolve against the same offsets (overlapping quotes nest marks). */
function applyWrap(
  block: HastNode,
  threadId: string,
  quote: string,
  start: number,
  end: number,
): void {
  let hasTrigger = false;
  const mark = (value: string, inLink: boolean): HastNode => {
    const trigger = !inLink && !hasTrigger;
    hasTrigger ||= trigger;
    return {
      type: "element",
      tagName: "mark",
      properties: {
        className: [MARK_CLASS],
        dataThreadId: threadId,
        ...(trigger ? { tabIndex: 0, role: "button", ariaLabel: `BTW: ${quote}` } : {}),
      },
      children: [{ type: "text", value }],
    };
  };

  const rewrite = (
    node: HastNode,
    cursor: number,
    inLink: boolean,
  ): { out: HastNode[]; cursor: number } => {
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
      out.push(mark(value.slice(s, e), inLink));
      if (e < len) out.push({ type: "text", value: value.slice(e) });
      return { out, cursor: nodeEnd };
    }
    // Elements keep their identity as containers; only their children are
    // rewritten, so inline structure survives (and overlapping quotes nest).
    const out: HastNode[] = [];
    let c = cursor;
    for (const child of node.children ?? []) {
      const result = rewrite(child, c, inLink || node.tagName === "a");
      out.push(...result.out);
      c = result.cursor;
    }
    node.children = out;
    return { out: [node], cursor: c };
  };

  const out: HastNode[] = [];
  let cursor = 0;
  for (const child of block.children ?? []) {
    const result = rewrite(child, cursor, false);
    out.push(...result.out);
    cursor = result.cursor;
  }
  block.children = out;
}

export function placeAnchors(
  tree: HastNode,
  anchors: readonly ThreadAnchor[],
): Map<string, Placement> {
  const blocks = (tree.children ?? []).filter((child) => child.type === "element");
  const placed = new Map<string, Placement>();
  for (const { threadId, anchor, mark } of anchors) {
    const found = resolvePassage(blocks, anchor);
    if (found === null || found.offset < 0) continue;
    placed.set(threadId, { offset: found.offset, start: found.start, end: found.end });
    if (mark) applyWrap(found.block, threadId, anchor.quote, found.start, found.end);
  }
  return placed;
}
