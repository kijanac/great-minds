import type { HastNode } from "$lib/markdown-plugins";

export interface Citation {
  n: number;
  label: string;
  href: string;
  path: string;
  kind: "article" | "source";
}

const LINK = /\[([^\]]+)\]\(((?:raw|wiki)\/[^)\s]+)\)/g;

export const citationPath = (href: string) => {
  const path = href.split("#", 1)[0] ?? href;
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
};

export function citationsOf(markdown: string): Citation[] {
  const seen = new Map<string, Citation>();
  for (const match of markdown.matchAll(LINK)) {
    const href = match[2] ?? "";
    const path = citationPath(href);
    if (seen.has(path)) continue;
    seen.set(path, {
      n: seen.size + 1,
      label: (match[1] ?? "").trim(),
      href,
      path,
      kind: path.startsWith("wiki/") ? "article" : "source",
    });
  }
  return [...seen.values()];
}

export function numberCitations(tree: HastNode, markdown: string): HastNode {
  const numbers = new Map(citationsOf(markdown).map((citation) => [citation.path, citation.n]));
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
