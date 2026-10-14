import GithubSlugger from "github-slugger";
import type { HastNode } from "$lib/markdown-plugins";

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const ANCHORED_TAGS = new Set([...HEADINGS, "p", "ul", "ol", "blockquote"]);
const textContent = (node: HastNode): string =>
  node.value ?? node.children?.map(textContent).join("") ?? "";

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
  const headings = new GithubSlugger();
  const walk = (node: HastNode): void => {
    if (node.type === "element" && node.tagName && HEADINGS.has(node.tagName)) {
      node.properties = { ...node.properties, id: headings.slug(textContent(node)) };
    }
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
          const id = `^p${marker.chunk}`;
          if (node.properties?.id) {
            node.children = [
              { type: "element", tagName: "span", properties: { id }, children: [] },
              ...(node.children ?? []),
            ];
          } else {
            node.properties = { ...node.properties, id };
          }
        }
      }
    }
    node.children?.forEach(walk);
  };
  walk(root);
}
