import { passageId, passageMarkers } from "@great-minds/domain";
import GithubSlugger from "github-slugger";

import { hastText, type HastNode } from "#lib/markdown-plugins.ts";

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const ANCHORED_TAGS = new Set([...HEADINGS, "p", "ul", "ol", "blockquote", "pre", "table", "hr"]);

export function assignBlockRefIds(root: HastNode, originalSource: string): void {
  let removed = 0;
  const markers = passageMarkers(originalSource).map((marker) => {
    const position = marker.at - removed;
    removed += marker.length;
    return { position, chunk: marker.passage };
  });

  const claimed = new Set<number>();
  const headings = new GithubSlugger();
  const walk = (node: HastNode): void => {
    if (node.type === "element" && node.tagName && HEADINGS.has(node.tagName)) {
      node.properties = {
        ...node.properties,
        id: headings.slug(hastText(node)),
      };
    }
    if (node.type === "element" && node.tagName && ANCHORED_TAGS.has(node.tagName)) {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start != null && end != null) {
        const marker = markers.find(
          (candidate) =>
            !claimed.has(candidate.chunk) &&
            candidate.position >= start &&
            candidate.position <= end + 2,
        );
        if (marker) {
          claimed.add(marker.chunk);
          const id = passageId(marker.chunk);
          if (node.properties?.id) {
            node.children = [
              {
                type: "element",
                tagName: "span",
                properties: { id },
                children: [],
              },
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
