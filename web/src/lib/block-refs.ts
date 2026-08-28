import type { HastNode } from "$lib/markdown-plugins";

const ANCHORED_TAGS = new Set(["h1", "h2", "h3", "p", "ul", "ol", "blockquote"]);

export function stripBlockRefMarkers(source: string): string {
  return source.replace(/\s*\^p\d+(?=\n|$)/gm, "");
}

export function assignBlockRefIds(root: HastNode, originalSource: string): void {
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

  const claimed = new Set<number>();
  const walk = (node: HastNode): void => {
    if (node.type === "element" && node.tagName && ANCHORED_TAGS.has(node.tagName)) {
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
  walk(root);
}
