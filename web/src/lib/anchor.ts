import { passageOf } from "@great-minds/domain";

export function uniqueQuoteSpan(
  text: string,
  quote: string,
): { start: number; end: number } | null {
  if (!quote) return null;
  const start = text.indexOf(quote);
  if (start < 0 || start !== text.lastIndexOf(quote)) return null;
  return { start, end: start + quote.length };
}

export function* quoteMatches(text: string, quote: string): Generator<number> {
  for (let start = text.indexOf(quote); start >= 0; start = text.indexOf(quote, start + 1))
    yield start;
}

const APP_TEXT = "[data-citation-ref]";

function passageText(root: Element | DocumentFragment): string {
  for (const element of root.querySelectorAll(APP_TEXT)) element.remove();
  return root.textContent ?? "";
}

const blockCopyText = (block: Element) => {
  const copy = block.cloneNode(true);
  return copy instanceof Element ? passageText(copy) : "";
};

const domSection = (block: Element) =>
  passageOf(block.id) ??
  (block.firstElementChild?.tagName === "SPAN" ? passageOf(block.firstElementChild.id) : null);

export function capturePassage(
  range: Range,
  block: HTMLElement,
): { quote: string; section: number | null; occurrence: number } {
  const selected = passageText(range.cloneContents());
  const quote = selected.trim();
  const lead = document.createRange();
  lead.setStart(block, 0);
  lead.setEnd(range.startContainer, range.startOffset);
  const quoteStart =
    passageText(lead.cloneContents()).length + selected.length - selected.trimStart().length;

  const earlier: Element[] = [];
  let section = domSection(block);
  for (
    let element = block.previousElementSibling;
    section === null && element;
    element = element.previousElementSibling
  ) {
    if (!element.hasAttribute("data-block-offset")) continue;
    earlier.unshift(element);
    section = domSection(element);
  }

  let occurrence = 1;
  for (const element of earlier)
    occurrence += [...quoteMatches(blockCopyText(element), quote)].length;
  for (const start of quoteMatches(blockCopyText(block), quote))
    if (start < quoteStart) occurrence += 1;
  return { quote, section, occurrence };
}

export function rangeFromOffsets(container: Node, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(APP_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
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
