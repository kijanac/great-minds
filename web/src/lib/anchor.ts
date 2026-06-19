// Build a Range over the first occurrence of `quote` within `container`'s text.
// The containing block is already pinned exactly by its source offset, so the
// quote only has to be located within that one block — where it's reliably
// unique — and we don't need fuzzy context matching.
function rangeFromOffsets(container: Node, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let count = 0;
  let startNode: Node | null = null;
  let startOff = 0;
  let endNode: Node | null = null;
  let endOff = 0;
  let n = walker.nextNode();
  while (n) {
    const len = n.textContent?.length ?? 0;
    if (startNode === null && start <= count + len) {
      startNode = n;
      startOff = start - count;
    }
    if (end <= count + len) {
      endNode = n;
      endOff = end - count;
      break;
    }
    count += len;
    n = walker.nextNode();
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  return range;
}

export function findQuoteRange(container: Node, quote: string): Range | null {
  if (!quote) return null;
  const text = container.textContent ?? "";
  const idx = text.indexOf(quote);
  if (idx < 0) return null;
  return rangeFromOffsets(container, idx, idx + quote.length);
}
