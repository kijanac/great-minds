import type { HastNode } from "$lib/markdown-plugins";
import { citationPath, type Citation } from "@great-minds/domain";

export type { Citation };

export function numberCitations(tree: HastNode, citations: readonly Citation[]): HastNode {
  const numbers = new Map(citations.map((citation) => [citation.path, citation.n]));
  const walk = (node: HastNode): void => {
    const href = node.properties?.href;
    if (
      node.type === "element" &&
      node.tagName === "a" &&
      typeof href === "string" &&
      (href.startsWith("raw/") || href.startsWith("wiki/"))
    ) {
      const n = numbers.get(citationPath(href));
      if (n !== undefined) node.properties = { ...node.properties, dataCitation: String(n) };
    }
    node.children?.forEach(walk);
  };
  walk(tree);
  return tree;
}

export function outlineOf(markdown: string): string[] {
  return [...markdown.matchAll(/^#{2,3}\s+(.+)$/gm)].map((match) =>
    (match[1] ?? "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .trim(),
  );
}
