import { useLayoutEffect, useState, type RefObject } from "react";

import { findQuoteRange } from "@/lib/anchor";
import { clearAnchorHighlights, setAnchorHighlights } from "@/lib/highlight";
import type { BtwThread } from "@/lib/types";

// For each BTW, find the block whose source offset matches the stored anchor
// (exact — no search), paint the quote's span highlight within it, and report
// which block offset each thread renders under. Placement is by block existence
// (robust); the highlight is best-effort on top. Threads whose block is gone map
// to -1 for a trailing fallback. Runs in a layout effect so placement is settled
// before paint (no flicker).
export function useAnchoredBtws(
  rootRef: RefObject<HTMLElement | null>,
  key: string,
  btws: BtwThread[],
  text: string,
): Map<string, number> {
  const [placement, setPlacement] = useState<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const ranges: Range[] = [];
    const next = new Map<string, number>();
    for (const btw of btws) {
      const block = root.querySelector<HTMLElement>(
        `[data-block-offset="${btw.anchor.blockOffset}"]`,
      );
      next.set(btw.id, block ? btw.anchor.blockOffset : -1);
      if (block) {
        const range = findQuoteRange(block, btw.anchor.quote);
        if (range) ranges.push(range);
      }
    }

    setAnchorHighlights(key, ranges);
    setPlacement(next);

    return () => clearAnchorHighlights(key);
    // `text` is a dep so placement/highlights recompute when the answer changes.
  }, [rootRef, key, btws, text]);

  return placement;
}
