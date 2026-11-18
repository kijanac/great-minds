const isSpace = (character: string) => /\s/.test(character);

export function selectionExcerpt(range: Range): string {
  const passage = range.cloneRange();
  const start = passage.startContainer;
  if (start.nodeType === Node.TEXT_NODE) {
    const text = start.textContent ?? "";
    let offset = passage.startOffset;
    while (offset > 0 && !isSpace(text.charAt(offset - 1))) offset -= 1;
    passage.setStart(start, offset);
  }
  const end = passage.endContainer;
  if (end.nodeType === Node.TEXT_NODE) {
    const text = end.textContent ?? "";
    let offset = passage.endOffset;
    while (offset < text.length && !isSpace(text.charAt(offset))) offset += 1;
    passage.setEnd(end, offset);
  }
  return withoutMarkers(passage.cloneContents()).replace(/\s+/g, " ").trim();
}

function withoutMarkers(root: Element | DocumentFragment): string {
  for (const marker of root.querySelectorAll("sup")) marker.remove();
  return root.textContent ?? "";
}
