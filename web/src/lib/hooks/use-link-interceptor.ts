import { goto } from "$app/navigation";
import { citationPath, citedPassage } from "@great-minds/domain";
import { clickedMarkdownLink } from "#lib/markdown-links.ts";

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
    const link = clickedMarkdownLink(event);
    if (link?.kind === "wiki") {
      event.preventDefault();
      void goto(`/doc/${link.href}`);
    } else if (link?.kind === "raw") {
      event.preventDefault();
      onRawOpen({ path: citationPath(link.href), chunk: citedPassage(link.href) });
    }
  };
}
