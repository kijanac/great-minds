import { goto } from "$app/navigation";

export interface RawCitation {
  path: string;
  chunk: number | null;
}

/**
 * Intercept internal knowledge-base links emitted by MarkdownView.
 *
 * Wiki links remain full document navigations. Raw links are handed to the
 * reader so it can open the side panel, including a parsed `^pN` chunk index.
 */
export function createLinkInterceptor(onRawOpen: (citation: RawCitation) => void) {
  return (event: MouseEvent): void => {
    const anchor =
      event.currentTarget instanceof HTMLAnchorElement
        ? event.currentTarget
        : event.target instanceof Element
          ? event.target.closest("a")
          : null;
    const href = anchor?.getAttribute("href");
    if (!href) return;

    if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("#")) {
      return;
    }

    if (href.startsWith("wiki/")) {
      event.preventDefault();
      void goto(`/doc/${href}`);
      return;
    }

    if (href.startsWith("raw/")) {
      event.preventDefault();
      const [path, fragment = ""] = href.split("#", 2);
      const match = /^\^p(\d+)$/.exec(decodeURIComponent(fragment));
      onRawOpen({
        path,
        chunk: match ? Number(match[1]) : null,
      });
    }
  };
}
