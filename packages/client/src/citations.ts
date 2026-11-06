export interface Citation {
  readonly n: number;
  readonly label: string;
  readonly href: string;
  readonly path: string;
  readonly kind: "article" | "source";
}

const LINK = /\[([^\]]+)\]\(((?:raw|wiki)\/[^)\s]+)\)/g;

export const citationPath = (href: string) => {
  const hash = href.indexOf("#");
  const path = hash === -1 ? href : href.slice(0, hash);
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
};

export const citationsOf = (markdown: string): Citation[] => {
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
};
