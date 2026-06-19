// A single registered `::highlight(btw-anchor)` shared across every render
// surface (each stacked AnswerBlock, the ArticleView). Surfaces contribute
// their ranges by key; we merge them into one Highlight. Using one named
// highlight avoids the per-instance clobbering of `CSS.highlights.set`.
const NAME = "btw-anchor";
const byKey = new Map<string, Range[]>();
let highlight: Highlight | null = null;

function supported(): boolean {
  return typeof Highlight !== "undefined" && typeof CSS !== "undefined" && !!CSS.highlights;
}

function flush(): void {
  if (!supported()) return;
  highlight ??= new Highlight();
  highlight.clear();
  for (const ranges of byKey.values()) {
    for (const range of ranges) highlight.add(range);
  }
  CSS.highlights.set(NAME, highlight);
}

export function setAnchorHighlights(key: string, ranges: Range[]): void {
  if (!supported()) return;
  if (ranges.length > 0) byKey.set(key, ranges);
  else byKey.delete(key);
  flush();
}

export function clearAnchorHighlights(key: string): void {
  if (byKey.delete(key)) flush();
}
