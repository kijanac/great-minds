export function uniqueQuoteSpan(
  text: string,
  quote: string,
): { start: number; end: number } | null {
  if (!quote) return null;
  const start = text.indexOf(quote);
  if (start < 0 || start !== text.lastIndexOf(quote)) return null;
  return { start, end: start + quote.length };
}

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
  const span = uniqueQuoteSpan(container.textContent ?? "", quote);
  return span === null ? null : rangeFromOffsets(container, span.start, span.end);
}
