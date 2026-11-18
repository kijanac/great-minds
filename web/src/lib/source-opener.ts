import { citationPath, citedPassage } from "@great-minds/domain";
import { getContext, setContext } from "svelte";

import { readingTrail, type ReadingTrail } from "#lib/research-steps.ts";
import type { Exchange, SourceRef } from "#lib/types.ts";

export interface SourceOpener {
  readonly openSource: (exchange: Exchange, source: SourceRef) => void;
  readonly openCitation: (exchange: Exchange, href: string) => void;
}

const key = Symbol("source-opener");

export const provideSourceOpener = (panel: {
  readonly openTrail: (trail: ReadingTrail) => void;
  readonly toggle: (source: SourceRef) => void;
  readonly openPath: (path: string, chunk: number | null) => void;
}): SourceOpener => {
  const opener: SourceOpener = {
    openSource: (exchange, source) => {
      const trail = readingTrail(exchange, source.label);
      if (trail) panel.openTrail(trail);
      else panel.toggle(source);
    },
    openCitation: (exchange, href) => {
      const chunk = citedPassage(href);
      const path = citationPath(href);
      const trail = readingTrail(exchange, path, chunk);
      if (trail) panel.openTrail(trail);
      else panel.openPath(path, chunk);
    },
  };
  setContext(key, opener);
  return opener;
};

export const useSourceOpener = () => getContext<SourceOpener | undefined>(key);

export const rawSourceHref = (event: Event) => {
  const href =
    event.target instanceof Element ? event.target.closest("a")?.getAttribute("href") : null;
  return href?.startsWith("raw/") ? href : null;
};
